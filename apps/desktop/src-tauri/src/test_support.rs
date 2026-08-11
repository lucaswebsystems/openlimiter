use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use zeroize::Zeroizing;

use crate::credentials::{CredentialError, SecretStore};
use crate::net::{Transport, TransportFailure, TransportReply};

/// Doubles for the tests, and only for the tests.
///
/// The credential double keeps secrets in memory so no test ever touches the
/// machine's real credential store, and the transport double records what it
/// was asked so no test ever opens a socket.
/// A directory that exists for one test and removes itself afterwards.
pub(crate) struct TempDir {
    path: PathBuf,
}

impl Default for TempDir {
    fn default() -> Self {
        Self::new()
    }
}

impl TempDir {
    pub(crate) fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("openlimiter-desktop-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("the test directory is creatable");
        Self { path }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// An in memory credential store with the same three verbs as the real one.
pub(crate) struct InMemorySecrets {
    map: Mutex<HashMap<String, String>>,
}

impl Default for InMemorySecrets {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemorySecrets {
    pub(crate) fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn stored_count(&self) -> usize {
        self.map.lock().expect("the secrets map is intact").len()
    }
}

impl SecretStore for InMemorySecrets {
    fn store_secret(&self, connection_id: &str, secret: &str) -> Result<(), CredentialError> {
        self.map
            .lock()
            .map_err(|_| CredentialError::Store)?
            .insert(connection_id.to_string(), secret.to_string());
        Ok(())
    }

    fn read_secret(&self, connection_id: &str) -> Result<Zeroizing<String>, CredentialError> {
        self.map
            .lock()
            .map_err(|_| CredentialError::Store)?
            .get(connection_id)
            .map(|secret| Zeroizing::new(secret.clone()))
            .ok_or(CredentialError::NotFound)
    }

    fn delete_secret(&self, connection_id: &str) -> Result<(), CredentialError> {
        self.map
            .lock()
            .map_err(|_| CredentialError::Store)?
            .remove(connection_id)
            .map(|_| ())
            .ok_or(CredentialError::NotFound)
    }
}

/// A transport that answers from a script and records every URL and secret it
/// was handed, so a test can prove only constant urls are ever fetched.
pub(crate) struct RecordingTransport {
    status: u16,
    body: Vec<u8>,
    retry_after_seconds: Option<u64>,
    urls: Mutex<Vec<&'static str>>,
    secrets: Mutex<Vec<String>>,
}

impl RecordingTransport {
    pub(crate) fn replying(status: u16, body: Vec<u8>, retry_after_seconds: Option<u64>) -> Self {
        Self {
            status,
            body,
            retry_after_seconds,
            urls: Mutex::new(Vec::new()),
            secrets: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn recorded_urls(&self) -> Vec<&'static str> {
        self.urls.lock().expect("the url record is intact").clone()
    }

    pub(crate) fn recorded_secrets(&self) -> Vec<String> {
        self.secrets
            .lock()
            .expect("the secret record is intact")
            .clone()
    }
}

/// A transport that always fails the same typed way, so the probe path's
/// transport failure arm can be exercised without a socket or a real fault.
pub(crate) struct FailingTransport {
    failure: TransportFailure,
}

impl FailingTransport {
    pub(crate) fn with(failure: TransportFailure) -> Self {
        Self { failure }
    }
}

impl Transport for FailingTransport {
    async fn get(
        &self,
        _url: &'static str,
        _bearer_secret: &str,
    ) -> Result<TransportReply, TransportFailure> {
        Err(self.failure)
    }
}

impl Transport for RecordingTransport {
    async fn get(
        &self,
        url: &'static str,
        bearer_secret: &str,
    ) -> Result<TransportReply, TransportFailure> {
        self.urls
            .lock()
            .expect("the url record is intact")
            .push(url);
        self.secrets
            .lock()
            .expect("the secret record is intact")
            .push(bearer_secret.to_string());
        Ok(TransportReply {
            status: self.status,
            body: self.body.clone(),
            retry_after_seconds: self.retry_after_seconds,
        })
    }
}
