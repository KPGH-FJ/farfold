use std::sync::Mutex;

/// Serialize final authorization and bounded delivery with revoke/close ACK.
#[derive(Default)]
pub struct OutboundGate(Mutex<()>);

impl OutboundGate {
    pub fn run<A, R>(&self, check: impl FnOnce() -> A, deliver: impl FnOnce(A) -> R) -> R {
        let _guard = self.0.lock().unwrap();
        let value = check();
        deliver(value)
    }
}
