//! Deadline classification through real admission/pump with owned test peers.
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn send_wait_timeout_before_enqueue_preserves_capacity_and_allows_explicit_retry() {
    checked(|s| {
        Box::pin(async move {
            let mut c = s.open(0, "timeout-early", "empty").await;
            let (request, mut progress) = s.request(&c, "early", Instant::now());
            let (body, _) = blocks(10);
            let error = s
                .manager
                .admit_prompt(Input {
                    agent: &c.agent,
                    cwd: &s.cwd,
                    session: &c.session,
                    blocks: body,
                    request,
                    store: &s.store,
                })
                .await
                .unwrap_err();
            assert_eq!(error, "FAILED: PROMPT_QUEUE_TIMEOUT");
            assert!(progress.try_recv().is_err());
            assert_eq!(s.manager.prompt_admission.counts(), (0, 0, 0));
            assert_eq!(s.lives[0].work.load(Ordering::SeqCst), 0);
            let (request, _retry_progress) =
                s.request(&c, "early", Instant::now() + Duration::from_secs(5));
            let (body, digest) = blocks(11);
            s.manager
                .admit_prompt(Input {
                    agent: &c.agent,
                    cwd: &s.cwd,
                    session: &c.session,
                    blocks: body,
                    request,
                    store: &s.store,
                })
                .await
                .unwrap();
            start(&mut c, &digest).await;
            s.manager
                .session_cancel(&c.agent, &s.cwd, &c.session)
                .await
                .unwrap();
            terminal(&mut c).await;
        })
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn send_wait_timeout_at_cwd_gate_never_offers_and_preserves_other_owner() {
    checked(|s| {
        Box::pin(async move {
            let mut c = s.open(0, "timeout-cwd", "empty").await;
            let error = {
                let entered = Arc::new(tokio::sync::Notify::new());
                let observed = entered.clone();
                let (release, receive) = tokio::sync::oneshot::channel();
                let held = crate::work_policy::admit(&s.store, &c.agent, &s.cwd, || async move {
                    observed.notify_one();
                    receive.await.unwrap();
                    Ok(())
                });
                tokio::pin!(held);
                tokio::select! {
                    _ = entered.notified() => {},
                    result = &mut held => panic!("gate unexpectedly completed: {result:?}"),
                }
                let (request, mut progress) =
                    s.request(&c, "cwd", Instant::now() + Duration::from_millis(50));
                let (body, _) = blocks(12);
                let error = s
                    .manager
                    .admit_prompt(Input {
                        agent: &c.agent,
                        cwd: &s.cwd,
                        session: &c.session,
                        blocks: body,
                        request,
                        store: &s.store,
                    })
                    .await
                    .unwrap_err();
                release.send(()).unwrap();
                held.await.unwrap();
                while let Ok(event) = progress.try_recv() {
                    assert_ne!(event.phase, Phase::Offered);
                }
                error
            };
            assert_eq!(error, "FAILED: PROMPT_QUEUE_TIMEOUT");
            assert_eq!(s.manager.prompt_admission.counts(), (0, 0, 0));
            assert_eq!(s.lives[0].work.load(Ordering::SeqCst), 0);
            let (request, _retry_progress) =
                s.request(&c, "cwd", Instant::now() + Duration::from_secs(5));
            let (body, digest) = blocks(13);
            s.manager
                .admit_prompt(Input {
                    agent: &c.agent,
                    cwd: &s.cwd,
                    session: &c.session,
                    blocks: body,
                    request,
                    store: &s.store,
                })
                .await
                .unwrap();
            start(&mut c, &digest).await;
            s.manager
                .session_cancel(&c.agent, &s.cwd, &c.session)
                .await
                .unwrap();
            terminal(&mut c).await;
        })
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn send_wait_timeout_after_commit_is_unknown_and_late_reply_keeps_other_owner() {
    checked(|s| {
        Box::pin(async move {
            let mut c = s.open(0, "timeout-committed", "empty").await;
            let receipt = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let error = {
                let (mut request, _) =
                    s.request(&c, "committed", Instant::now() + Duration::from_millis(100));
                let entered = Arc::new(tokio::sync::Notify::new());
                let observed = entered.clone();
                let observed_receipt = receipt.clone();
                let (release, receive) = std::sync::mpsc::channel();
                let receive = std::sync::Mutex::new(Some(receive));
                request.progress = Arc::new(move |event| {
                    if event.phase == Phase::Offered {
                        observed_receipt.store(event.receipt_id, Ordering::SeqCst);
                        observed.notify_one();
                        receive
                            .lock()
                            .unwrap()
                            .take()
                            .unwrap()
                            .recv_timeout(Duration::from_secs(5))
                            .unwrap();
                    }
                    Ok(())
                });
                let (body, _) = blocks(14);
                let pending = s.manager.admit_prompt(Input {
                    agent: &c.agent,
                    cwd: &s.cwd,
                    session: &c.session,
                    blocks: body,
                    request,
                    store: &s.store,
                });
                tokio::pin!(pending);
                tokio::select! {
                    _ = entered.notified() => {},
                    result = &mut pending => panic!("commit fence not reached: {result:?}"),
                }
                let outcome = pending.await;
                release.send(()).unwrap();
                outcome.unwrap_err()
            };
            assert!(
                !error.starts_with("FAILED:"),
                "committed work cannot be rejected unsent"
            );
            assert_eq!(s.manager.prompt_admission.counts().0, 1);
            assert_eq!(s.lives[0].work.load(Ordering::SeqCst), 1);
            let (_, digest) = blocks(14);
            start(&mut c, &digest).await;
            let owner =
                s.manager
                    .prompt_admission
                    .fixture_owner("owned-window", "committed", &c.agent);
            assert_eq!(
                s.manager
                    .prompt_admission
                    .cancel(receipt.load(Ordering::SeqCst), &owner),
                Ok(Cancel::AlreadyStarting)
            );
            let mut other = s.open(1, "timeout-other", "empty").await;
            let (body, other_digest) = blocks(15);
            s.manager
                .session_prompt(&other.agent, &s.cwd, &other.session, body)
                .await
                .unwrap();
            start(&mut other, &other_digest).await;
            s.manager
                .session_cancel(&c.agent, &s.cwd, &c.session)
                .await
                .unwrap();
            terminal(&mut c).await;
            assert_eq!(s.manager.prompt_admission.counts().0, 1);
            assert_eq!(s.lives[1].work.load(Ordering::SeqCst), 1);
            s.manager
                .session_cancel(&other.agent, &s.cwd, &other.session)
                .await
                .unwrap();
            terminal(&mut other).await;
        })
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn send_wait_timeout_does_not_replace_a_prior_explicit_cancel_at_cwd_gate() {
    checked(|s| Box::pin(async move {
        let c = s.open(0, "cancel-before-timeout", "empty").await;
        let entered = Arc::new(tokio::sync::Notify::new());
        let observed = entered.clone();
        let (release, receive) = tokio::sync::oneshot::channel();
        let held = crate::work_policy::admit(&s.store, &c.agent, &s.cwd, || async move {
            observed.notify_one(); receive.await.unwrap(); Ok(())
        });
        tokio::pin!(held);
        tokio::select! { _ = entered.notified() => {}, r = &mut held => panic!("gate ended: {r:?}") }
        let (request, mut progress) = s.request(&c, "manual-first", Instant::now() + Duration::from_millis(100));
        let owner = request.owner.clone();
        let (body, _) = blocks(16);
        let pending = s.manager.admit_prompt(Input {
            agent: &c.agent, cwd: &s.cwd, session: &c.session,
            blocks: body, request, store: &s.store,
        });
        tokio::pin!(pending);
        let mut receipt = 0;
        for _ in 0..2 {
            tokio::select! {
                event = progress.recv() => {
                    let event = event.unwrap(); assert_eq!(event.phase, Phase::Preparing);
                    receipt = event.receipt_id;
                },
                result = &mut pending => panic!("request resolved before manual cancel: {result:?}"),
            }
        }
        assert_eq!(s.manager.prompt_admission.cancel(receipt, &owner), Ok(Cancel::CancelledWaiting));
        let outcome = pending.await;
        release.send(()).unwrap(); held.await.unwrap();
        assert_eq!(outcome.unwrap_err(), "FAILED: PROMPT_QUEUE_CANCELLED");
        assert_eq!(s.manager.prompt_admission.counts(), (0, 0, 0));
        assert_eq!(s.lives[0].work.load(Ordering::SeqCst), 0);
    })).await;
}
