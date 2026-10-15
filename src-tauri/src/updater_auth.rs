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
        let response = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
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
