use std::time::Duration;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Updater, UpdaterExt};

pub struct ServerConnection {
    pub url: String,
    pub token: String,
}

impl ServerConnection {
    pub fn new(url: String) -> Result<Self, String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| "Could not secure the desktop credential connection.")?;
        Ok(Self {
            url,
            token: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
        })
    }
}

pub fn is_gitlab_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("git.insea.io")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

fn needs_gitlab_credentials(endpoints: &[Url]) -> Result<bool, String> {
    let internal = endpoints.iter().any(is_gitlab_url);
    if internal && !endpoints.iter().all(is_gitlab_url) {
        return Err("GitLab update endpoints cannot be mixed with other servers.".into());
    }
    Ok(internal)
}

fn credentials_client() -> Result<reqwest::Client, reqwest::Error> {
    // The updater enables reqwest's rustls-no-provider feature, but only installs
    // ring during Updater::check. Our credential request happens before that.
    // An existing process-wide provider is also valid; installation is idempotent.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
}

pub async fn get_updater(app: &AppHandle) -> Result<Updater, String> {
    let endpoints = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .ok_or("Missing update endpoints.")?
        .iter()
        .map(|endpoint| {
            endpoint
                .as_str()
                .and_then(|url| Url::parse(url).ok())
                .ok_or("Invalid update endpoint.")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut builder = app.updater_builder();
    if needs_gitlab_credentials(&endpoints)? {
        let connection = app
            .try_state::<ServerConnection>()
            .ok_or("Desktop update credentials are not ready. Please try again.")?;
        let response = credentials_client()
            .map_err(|_| "Could not initialize update credentials connection.")?
            .get(format!(
                "{}/api/internal/updater-credentials",
                connection.url
            ))
            .header("X-Trident-Token", &connection.token)
            .send()
            .await
            .map_err(|_| "Could not load GitLab update credentials. Please try again.")?
            .error_for_status()
            .map_err(|_| "Could not load GitLab update credentials. Please try again.")?;
        let credentials: serde_json::Value = response
            .json()
            .await
            .map_err(|_| "Invalid GitLab update credentials response.")?;
        let token = credentials.get("token").and_then(|value| value.as_str())
            .filter(|token| !token.trim().is_empty())
            .ok_or("Add a GitLab account for https://git.insea.io in Credentials to check for updates. The token needs api scope and access to the Trident project and packages.")?;
        let mut value = reqwest::header::HeaderValue::from_str(token)
            .map_err(|_| "Invalid GitLab update token.")?;
        value.set_sensitive(true);
        // Tauri preserves these headers for the package download as well as the manifest check.
        builder = builder
            .header("PRIVATE-TOKEN", value)
            .map_err(|_| "Invalid GitLab update token.")?
            .configure_client(|client| {
                client.redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 10 {
                        attempt.error("Too many update redirects")
                    } else if is_gitlab_url(attempt.url()) {
                        attempt.follow()
                    } else {
                        attempt.error("Update redirect left the GitLab server")
                    }
                }))
            });
    }
    builder.build().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn credentials_client_works_before_updater_initializes_tls() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // The credential bridge is contacted before Updater::check installs its
        // Rustls provider. Constructing our client must work in a fresh process.
        let client = credentials_client().expect("credential client initializes without updater");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.ends_with(b"\r\n\r\n") {
                let count = stream.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /api/internal/updater-credentials HTTP/1.1\r\n"));
            assert!(request.to_ascii_lowercase().contains("x-trident-token: test-secret\r\n"));
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
        });
        let response = client
            .get(format!("http://{address}/api/internal/updater-credentials"))
            .header("X-Trident-Token", "test-secret")
            .send().await.unwrap();
        assert_eq!(response.json::<serde_json::Value>().await.unwrap(), serde_json::json!({}));
        server.await.unwrap();
    }

    #[test]
    fn credentials_are_limited_to_https_gitlab_origin() {
        assert!(is_gitlab_url(
            &Url::parse("https://git.insea.io/api/v4/packages").unwrap()
        ));
        for endpoint in [
            "http://git.insea.io/api/v4",
            "https://git.insea.io.evil.test/",
            "https://git.insea.io:8443/",
            "https://user:secret@git.insea.io/",
        ] {
            assert!(!is_gitlab_url(&Url::parse(endpoint).unwrap()), "{endpoint}");
        }
        let internal = Url::parse("https://git.insea.io/api/v4").unwrap();
        let external = Url::parse("https://github.com/releases").unwrap();
        assert_eq!(needs_gitlab_credentials(&[internal.clone()]).unwrap(), true);
        assert_eq!(
            needs_gitlab_credentials(&[external.clone()]).unwrap(),
            false
        );
        assert!(needs_gitlab_credentials(&[internal, external]).is_err());
    }

    #[test]
    fn bridge_secret_is_unique_per_launch() {
        let first = ServerConnection::new("http://127.0.0.1:3100".into()).unwrap();
        let second = ServerConnection::new(first.url.clone()).unwrap();
        assert_eq!(first.token.len(), 64);
        assert_ne!(first.token, second.token);
    }
}
