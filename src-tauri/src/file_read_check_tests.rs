use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc,
};

pub(crate) static PRODUCTION_CHECKS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn hung_check_times_out_but_keeps_admission_until_the_os_work_finishes() {
    let admission = Arc::new(Semaphore::new(1));
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = mpsc::channel();
    let checks = Arc::new(AtomicUsize::new(0));
    let work = checks.clone();
    let gate = admission.clone();
    let mut request = tokio::spawn(async move {
        run_with(gate, Duration::from_millis(30), move || {
            work.fetch_add(1, Ordering::SeqCst);
            started.send(()).unwrap();
            blocked.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(42)
        })
        .await
    });
    tokio::time::timeout(Duration::from_secs(1), ready)
        .await
        .unwrap()
        .unwrap();
    let response = tokio::time::timeout(Duration::from_millis(500), &mut request).await;
    // The fixture always releases its thread, even when the old unbounded
    // implementation fails. It never leaves a hanging test runtime behind.
    if response.is_err() {
        release.send(()).unwrap();
        request.await.unwrap().unwrap();
        panic!("the file-check response must finish before its OS work returns");
    }
    assert_eq!(response.unwrap().unwrap(), Err(WAIT_EXPIRED.to_owned()));
    assert_eq!(admission.available_permits(), 0);
    for _ in 0..4 {
        let work = checks.clone();
        assert_eq!(
            run_with(admission.clone(), Duration::from_millis(30), move || {
                work.fetch_add(1, Ordering::SeqCst);
                Ok(99)
            })
            .await,
            Err(CHECK_BUSY.to_owned())
        );
    }
    assert_eq!(checks.load(Ordering::SeqCst), 1);
    release.send(()).unwrap();
    // The response has already completed with an error. Its late success
    // has no remaining response channel and only releases the permit.
    drop(
        tokio::time::timeout(Duration::from_secs(1), admission.acquire())
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        run_with(admission, Duration::from_secs(1), || Ok(7)).await,
        Ok(7)
    );
}

#[tokio::test]
async fn dropping_the_reply_also_keeps_the_real_worker_slot() {
    let admission = Arc::new(Semaphore::new(1));
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = mpsc::channel();
    let gate = admission.clone();
    let request = tokio::spawn(async move {
        run_with(gate, Duration::from_secs(5), move || {
            started.send(()).unwrap();
            blocked.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(42)
        })
        .await
    });
    tokio::time::timeout(Duration::from_secs(1), ready)
        .await
        .unwrap()
        .unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(admission.available_permits(), 0);
    assert_eq!(
        run_with(admission.clone(), Duration::from_secs(1), || Ok(99)).await,
        Err(CHECK_BUSY.to_owned())
    );
    release.send(()).unwrap();
    drop(
        tokio::time::timeout(Duration::from_secs(1), admission.acquire())
            .await
            .unwrap()
            .unwrap(),
    );
}

#[tokio::test]
async fn production_checks_share_one_capacity_limit() {
    let _checks = PRODUCTION_CHECKS.lock().await;
    let mut requests = Vec::new();
    let mut releases = Vec::new();
    for value in 0..MAX_IN_FLIGHT {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, blocked) = mpsc::channel();
        releases.push(release);
        requests.push(tokio::spawn(run(move || {
            started.send(()).unwrap();
            blocked.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(value)
        })));
        tokio::time::timeout(Duration::from_secs(1), ready)
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(
        tokio::time::timeout(Duration::from_millis(500), run(|| Ok(99)))
            .await
            .unwrap(),
        Err(CHECK_BUSY.to_owned())
    );
    for release in releases {
        release.send(()).unwrap();
    }
    for (value, request) in requests.into_iter().enumerate() {
        assert_eq!(request.await.unwrap(), Ok(value));
    }
}

#[tokio::test]
async fn successful_and_failed_checks_preserve_results_and_release_slots() {
    let admission = Arc::new(Semaphore::new(1));
    assert_eq!(
        run_with(admission.clone(), Duration::from_secs(1), || Ok(7)).await,
        Ok(7)
    );
    assert_eq!(admission.available_permits(), 1);
    assert_eq!(
        run_with::<(), _>(admission.clone(), Duration::from_secs(1), || {
            Err(DeliveryError::Changed.message().to_owned())
        })
        .await,
        Err(DeliveryError::Changed.message().to_owned())
    );
    assert_eq!(admission.available_permits(), 1);
    assert_eq!(
        run_with::<(), _>(admission.clone(), Duration::from_secs(1), || {
            panic!("controlled file-check failure")
        })
        .await,
        Err(DeliveryError::Unavailable.message().to_owned())
    );
    assert_eq!(admission.available_permits(), 1);
}

#[test]
fn fixed_read_check_classification_distinguishes_pending_busy_and_other_errors() {
    assert_eq!(classify_error(WAIT_EXPIRED), FailureKind::Pending);
    assert_eq!(classify_error(CHECK_BUSY), FailureKind::Busy);
    assert_eq!(classify_error("untrusted"), FailureKind::Unavailable);
}
