pub(crate) fn ensure_rustls_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

#[cfg(test)]
mod tests {
    use super::ensure_rustls_crypto_provider;

    #[test]
    fn ring_provider_installation_is_idempotent() {
        ensure_rustls_crypto_provider();
        ensure_rustls_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
