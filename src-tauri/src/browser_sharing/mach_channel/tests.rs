use super::*;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn public_name_parser_accepts_only_our_bounded_nonsecret_service_shape() {
    let good = format!("{PREFIX}{}", "0123456789abcdef".repeat(2));
    assert!(valid_name(&good));
    for bad in [
        String::new(),
        format!("{good}\0"),
        format!("{good}/other"),
        good.to_uppercase(),
        format!("{PREFIX}{}", "a".repeat(31)),
        "com.apple.some-service".to_owned(),
    ] {
        assert!(!valid_name(&bad));
        assert!(connect(&bad, std::process::id()).is_err());
    }
    assert!(connect(&good, 0).is_err());
    assert!(connect(&good, u32::MAX).is_err());
}

#[test]
fn sdk_message_layout_matches_audit_and_fileport_abi() {
    assert_eq!(std::mem::size_of::<ffi::Header>(), 24);
    assert_eq!(std::mem::size_of::<ffi::PortDescriptor>(), 12);
    assert_eq!(std::mem::size_of::<ffi::Packet>(), 44);
    assert_eq!(std::mem::size_of::<ffi::AuditToken>(), 32);
    assert_eq!(std::mem::size_of::<ffi::AuditTrailer>(), 52);
    assert!(identity::authenticate(ffi::AuditToken::default()).is_err());
}

#[test]
fn empty_receive_is_bounded_without_retiring_the_port() {
    let port = message::ReceivePort::new().unwrap();
    assert!(port.receive(Duration::ZERO).unwrap().is_none());
    assert!(port.receive(Duration::from_millis(1)).unwrap().is_none());
}

// These are real macOS kernel/Security/fileport checks between two threads in
// this signed test process. They do not prove a real Agent's helper topology.
#[test]
fn audited_private_pair_moves_bytes_and_sets_close_on_exec() {
    let server = Server::bind().unwrap();
    let name = server.name().to_owned();
    let pid = server.broker_pid();
    let helper = std::thread::spawn(move || {
        let mut stream = connect(&name, pid).unwrap();
        assert_ne!(
            unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        stream.set_read_timeout(Some(HANDSHAKE_WAIT)).unwrap();
        stream.write_all(b"PING").unwrap();
        let mut reply = [0; 4];
        stream.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"PONG");
    });
    let mut stream = server
        .accept(
            &|peer| peer.pid == pid && peer.uid == unsafe { libc::geteuid() },
            HANDSHAKE_WAIT,
        )
        .unwrap()
        .unwrap();
    assert_ne!(
        unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
    stream.set_read_timeout(Some(HANDSHAKE_WAIT)).unwrap();
    let mut request = [0; 4];
    stream.read_exact(&mut request).unwrap();
    assert_eq!(&request, b"PING");
    stream.write_all(b"PONG").unwrap();
    helper.join().unwrap();
    assert_eq!(stream.read(&mut request).unwrap(), 0);
}

#[test]
fn admission_is_rechecked_before_fileport_grant() {
    for retire_at in [0, 1] {
        let server = Server::bind().unwrap();
        let name = server.name().to_owned();
        let pid = server.broker_pid();
        let helper = std::thread::spawn(move || connect(&name, pid).is_err());
        let calls = AtomicUsize::new(0);
        assert!(
            server
                .accept(
                    &|_| calls.fetch_add(1, Ordering::SeqCst) < retire_at,
                    HANDSHAKE_WAIT
                )
                .unwrap()
                .is_none()
        );
        assert!(helper.join().unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), retire_at + 1);
        // Refusal of one helper is not a listener shutdown.
        assert!(server.accept(&|_| true, Duration::ZERO).unwrap().is_none());
    }
}

#[test]
fn helper_rejects_an_authenticated_but_different_broker_pid_before_application_io() {
    let server = Server::bind().unwrap();
    let name = server.name().to_owned();
    let helper = std::thread::spawn(move || connect(&name, std::process::id() + 1).is_err());
    let mut stream = server.accept(&|_| true, HANDSHAKE_WAIT).unwrap().unwrap();
    stream.set_read_timeout(Some(HANDSHAKE_WAIT)).unwrap();
    assert!(helper.join().unwrap());
    assert_eq!(stream.read(&mut [0_u8; 1]).unwrap(), 0);
}

#[test]
fn dropped_server_never_grants_a_channel_using_its_old_public_name() {
    let server = Server::bind().unwrap();
    let name = server.name().to_owned();
    let pid = server.broker_pid();
    drop(server);
    // launchd may already remove the name or return a dead send right. Neither
    // condition permits a rendezvous; exact spelling removal is not assumed.
    assert!(connect(&name, pid).is_err());
}
