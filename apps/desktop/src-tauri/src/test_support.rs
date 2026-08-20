use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use zeroize::Zeroizing;

use crate::credentials::{CredentialError, SecretStore};
use crate::net::{
    EndpointRequest, HttpMethod, Transport, TransportFailure, TransportReply, WorkspaceHandle,
};
use crate::reader_registry::AuthApplication;

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
    replies: Mutex<VecDeque<RecordedReply>>,
    /// A workspace handle the double pretends a redirect named, so the two hop
    /// OpenCode read can be exercised without a socket.
    workspace: Option<WorkspaceHandle>,
    urls: Mutex<Vec<String>>,
    secrets: Mutex<Vec<String>>,
    methods: Mutex<Vec<HttpMethod>>,
    auths: Mutex<Vec<AuthApplication>>,
    provider_account_ids: Mutex<Vec<Option<String>>>,
    bodies: Mutex<Vec<Option<String>>>,
}

#[derive(Clone)]
struct RecordedReply {
    status: u16,
    body: Vec<u8>,
    retry_after_seconds: Option<u64>,
}

impl RecordingTransport {
    pub(crate) fn replying(status: u16, body: Vec<u8>, retry_after_seconds: Option<u64>) -> Self {
        Self::scripted(vec![(status, body, retry_after_seconds)])
    }

    /// Ordered replies for multi hop readers. The last reply repeats if a
    /// caller makes more requests than the script contains.
    pub(crate) fn scripted(replies: Vec<(u16, Vec<u8>, Option<u64>)>) -> Self {
        assert!(!replies.is_empty(), "a transport script needs one reply");
        Self {
            replies: Mutex::new(
                replies
                    .into_iter()
                    .map(|(status, body, retry_after_seconds)| RecordedReply {
                        status,
                        body,
                        retry_after_seconds,
                    })
                    .collect(),
            ),
            /* Every OpenCode read is two hops, so the default double names a
            workspace: a double that never did would make the second hop
            unreachable in every test that is not about a dead session. */
            workspace: WorkspaceHandle::parse("wrk_testworkspace"),
            urls: Mutex::new(Vec::new()),
            secrets: Mutex::new(Vec::new()),
            methods: Mutex::new(Vec::new()),
            auths: Mutex::new(Vec::new()),
            provider_account_ids: Mutex::new(Vec::new()),
            bodies: Mutex::new(Vec::new()),
        }
    }

    /// A double whose entry point names no workspace, which is what a dead
    /// OpenCode session looks like from outside.
    pub(crate) fn without_workspace(mut self) -> Self {
        self.workspace = None;
        self
    }

    pub(crate) fn recorded_urls(&self) -> Vec<String> {
        self.urls.lock().expect("the url record is intact").clone()
    }

    pub(crate) fn recorded_secrets(&self) -> Vec<String> {
        self.secrets
            .lock()
            .expect("the secret record is intact")
            .clone()
    }

    pub(crate) fn recorded_methods(&self) -> Vec<HttpMethod> {
        self.methods
            .lock()
            .expect("the method record is intact")
            .clone()
    }

    pub(crate) fn recorded_auths(&self) -> Vec<AuthApplication> {
        self.auths
            .lock()
            .expect("the auth record is intact")
            .clone()
    }

    pub(crate) fn recorded_codex_account_ids(&self) -> Vec<Option<String>> {
        self.provider_account_ids
            .lock()
            .expect("the account header record is intact")
            .clone()
    }

    pub(crate) fn recorded_provider_account_ids(&self) -> Vec<Option<String>> {
        self.provider_account_ids
            .lock()
            .expect("the account header record is intact")
            .clone()
    }

    pub(crate) fn recorded_bodies(&self) -> Vec<Option<String>> {
        self.bodies
            .lock()
            .expect("the body record is intact")
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
    async fn send(
        &self,
        _request: &EndpointRequest<'_>,
        _secret: &str,
    ) -> Result<TransportReply, TransportFailure> {
        Err(self.failure)
    }
}

impl Transport for RecordingTransport {
    async fn send(
        &self,
        request: &EndpointRequest<'_>,
        secret: &str,
    ) -> Result<TransportReply, TransportFailure> {
        self.urls
            .lock()
            .expect("the url record is intact")
            .push(request.url.to_string());
        self.secrets
            .lock()
            .expect("the secret record is intact")
            .push(secret.to_string());
        self.methods
            .lock()
            .expect("the method record is intact")
            .push(request.method);
        self.auths
            .lock()
            .expect("the auth record is intact")
            .push(request.auth);
        self.provider_account_ids
            .lock()
            .expect("the account header record is intact")
            .push(request.provider_account_id.map(str::to_string));
        self.bodies
            .lock()
            .expect("the body record is intact")
            .push(request.body.map(str::to_string));
        let reply = {
            let mut replies = self.replies.lock().expect("the reply script is intact");
            if replies.len() > 1 {
                replies.pop_front().expect("the reply script is nonempty")
            } else {
                replies
                    .front()
                    .expect("the reply script is nonempty")
                    .clone()
            }
        };
        Ok(TransportReply {
            status: reply.status,
            body: reply.body,
            retry_after_seconds: reply.retry_after_seconds,
            location_workspace: self.workspace.clone(),
        })
    }
}
