//! One volatile native request owner. Retirement releases its reply, not its JS.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::Instant;

const REPLY_WAIT: Duration = Duration::from_secs(8);
static NEXT: AtomicU64 = AtomicU64::new(1);

pub(super) struct NativeRequest {
    id: u64,
    deadline: Instant,
    retire: Option<Box<dyn FnOnce(u64) + Send>>,
}

impl NativeRequest {
    pub(super) fn new(retire: impl FnOnce(u64) + Send + 'static) -> Result<Self, String> {
        let id = NEXT
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| "无法准备网页请求，请重新打开应用")?;
        Ok(Self {
            id,
            deadline: Instant::now() + REPLY_WAIT,
            retire: Some(Box::new(retire)),
        })
    }
    pub(super) fn id(&self) -> u64 {
        self.id
    }

    pub(super) async fn reply(
        mut self,
        receiver: oneshot::Receiver<Result<String, String>>,
    ) -> Result<String, String> {
        match tokio::time::timeout_at(self.deadline, receiver).await {
            Ok(Ok(result)) => {
                self.retire = None;
                result
            }
            Ok(Err(_)) => Err("网页请求结果未确认，请查看页面；不要自动重试".into()),
            Err(_) => {
                Err("网页请求等待超时，执行是否结束尚未确认；请等待或关闭网页，不要自动重试".into())
            }
        }
    }
}
impl Drop for NativeRequest {
    fn drop(&mut self) {
        if let Some(retire) = self.retire.take() {
            retire(self.id);
        }
    }
}

// WebView2's detached operation remains occupied after its receiver retires.
// This is shared with platform-independent tests, not a claim of WebView2 execution.
#[cfg(any(windows, test))]
pub(super) struct PendingOperation {
    pub id: u64,
    pub reply: Option<oneshot::Sender<Result<String, String>>>,
    pub action: Option<String>,
}
#[cfg(any(windows, test))]
impl PendingOperation {
    pub fn take_matching(slot: &std::cell::RefCell<Option<Self>>, id: u64) -> Option<Self> {
        let mut pending = slot.borrow_mut();
        if pending.as_ref().is_some_and(|pending| pending.id == id) {
            pending.take()
        } else {
            None
        }
    }
    pub fn retire_matching(slot: &std::cell::RefCell<Option<Self>>, id: u64) -> bool {
        let mut slot = slot.borrow_mut();
        if let Some(pending) = slot.as_mut().filter(|pending| pending.id == id) {
            pending.reply.take();
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    fn owner() -> (NativeRequest, Arc<Mutex<Vec<u64>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let copy = calls.clone();
        (
            NativeRequest::new(move |id| copy.lock().unwrap().push(id)).unwrap(),
            calls,
        )
    }
    #[test]
    fn dropping_waiter_retires_exact_nonzero_operation_once() {
        let (a, calls) = owner();
        let first = a.id();
        let (b, _) = owner();
        assert_ne!(first, 0);
        assert_ne!(first, b.id());
        drop(a);
        assert_eq!(*calls.lock().unwrap(), [first]);
    }
    #[tokio::test]
    async fn completed_callback_disarms_retirement_even_when_result_is_error() {
        for result in [
            Ok("controlled".to_owned()),
            Err("controlled rejection".to_owned()),
        ] {
            let (request, calls) = owner();
            let (sender, receiver) = oneshot::channel();
            sender.send(result.clone()).unwrap();
            assert_eq!(request.reply(receiver).await, result);
            assert!(calls.lock().unwrap().is_empty());
        }
    }
    #[tokio::test]
    async fn deadline_retires_receiver_but_does_not_claim_native_execution_ended() {
        let (mut request, calls) = owner();
        let id = request.id();
        request.deadline = Instant::now();
        let (sender, receiver) = oneshot::channel();
        let error = request.reply(receiver).await.unwrap_err();
        assert!(error.contains("执行是否结束尚未确认"));
        assert_eq!(*calls.lock().unwrap(), [id]);
        assert!(sender.send(Ok("late body".into())).is_err());
    }
    #[tokio::test]
    async fn receiver_closure_does_not_silently_disarm_an_unconfirmed_request() {
        let (request, calls) = owner();
        let id = request.id();
        let (sender, receiver) = oneshot::channel();
        drop(sender);
        assert!(request.reply(receiver).await.is_err());
        assert_eq!(*calls.lock().unwrap(), [id]);
    }
    #[tokio::test]
    async fn aborting_a_pending_wait_retires_its_exact_native_operation() {
        let (request, calls) = owner();
        let id = request.id();
        let (_sender, receiver) = oneshot::channel();
        let mut wait = Box::pin(request.reply(receiver));
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        assert!(std::future::Future::poll(wait.as_mut(), &mut context).is_pending());
        drop(wait);
        assert_eq!(*calls.lock().unwrap(), [id]);
    }
    #[test]
    fn retired_windows_reply_keeps_slot_until_exact_completion() {
        use std::cell::RefCell;
        let (a_reply, mut a_receive) = oneshot::channel();
        let slot = RefCell::new(Some(PendingOperation {
            id: 1,
            reply: Some(a_reply),
            action: Some("a".into()),
        }));
        assert!(!PendingOperation::retire_matching(&slot, 2));
        assert!(matches!(
            a_receive.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(PendingOperation::retire_matching(&slot, 1));
        assert!(PendingOperation::retire_matching(&slot, 1));
        assert!(matches!(
            a_receive.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(
            slot.borrow().is_some(),
            "retirement does not admit a successor"
        );
        assert_eq!(slot.borrow().as_ref().unwrap().action.as_deref(), Some("a"));
        assert!(PendingOperation::take_matching(&slot, 2).is_none());
        assert!(
            PendingOperation::take_matching(&slot, 1)
                .unwrap()
                .reply
                .is_none()
        );
        let (b_reply, mut b_receive) = oneshot::channel();
        *slot.borrow_mut() = Some(PendingOperation {
            id: 2,
            reply: Some(b_reply),
            action: None,
        });
        assert!(!PendingOperation::retire_matching(&slot, 1));
        assert!(PendingOperation::take_matching(&slot, 1).is_none());
        assert!(matches!(
            b_receive.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        PendingOperation::take_matching(&slot, 2)
            .unwrap()
            .reply
            .unwrap()
            .send(Ok("b".into()))
            .unwrap();
        assert_eq!(b_receive.try_recv().unwrap().unwrap(), "b");
    }
}
