# Identity providers

ICC signs users in through Okta. The UI presents Okta as the provider; underneath, each provider uses OpenID Connect (the recommended protocol) or SAML 2.0, chosen once when the provider is created. Providers are managed under Global Settings > Users & Access > Identity providers, the same tab that holds the Active Directory connection. Local accounts and Active Directory keep working beside them.

## How access works

A provider never grants access by itself. Access comes from linked groups, the same rule as Active Directory.

1. An administrator links an identity provider group to an ICC group (Users & Access > Groups > New group, then pick the provider in the source toggle). The ICC group carries the platform grants.
2. At sign-in ICC reads the groups the provider sends and matches them to linked groups by name (case-insensitive), or by Okta group id when the Management API sync supplied one.
3. No match and the user is not pinned: sign-in is refused with "Your account is not in any group that has access to this dashboard." and no user row is created.
4. Users added by an administrator (Users & Access > Users > Create user, source set to the provider) are pinned. A pinned user signs in with no group match and is never deactivated by the sync.

Users are never linked to an existing local or Active Directory account. If the username is taken by another identity, the new user is stored as `<username>#<provider slug>`.

## URLs

The provider drawer shows the URLs to paste into Okta once the provider is saved. They are built from `icc_base_url` (Global Settings > Intelligence > Agent notifications). When that setting is blank the drawer warns that the URLs come from the browser's host, which is wrong behind a proxy. Set it first.

| Purpose | Path |
| --- | --- |
| OIDC sign-in redirect URI | `<base>/api/auth/sso/<slug>/callback` |
| SAML ACS URL | `<base>/api/auth/sso/<slug>/acs` |
| SAML SP metadata | `<base>/api/auth/sso/<slug>/metadata` |
| Start a sign-in | `<base>/api/auth/sso/<slug>/start?returnTo=/` |

## Okta OIDC app

1. In Okta Admin, Applications > Create App Integration > OIDC, Web Application.
2. Sign-in redirect URI: the value shown in the drawer. Sign-out redirect: leave blank. Assign the groups that should sign in.
3. Sign On tab > OpenID Connect ID Token > Groups claim filter: `groups`, Matches regex, `.*`. Okta sends at most 100 groups in a token. The Management API sync covers the rest.
4. In ICC add an OIDC provider: Issuer URL is the Okta org (for example `https://example.okta.com`) or a custom authorization server URL, Client ID and Client secret come from the Okta app. Press Save and test, then switch Enabled on.

Defaults: scopes `openid profile email groups`, subject claim `sub` (the Okta user id), email `email`, name `name`, groups `groups`. ICC uses the authorization code flow with PKCE and accepts RS256 ID tokens only.

## Okta SAML app

1. In Okta Admin, Applications > Create App Integration > SAML 2.0.
2. Single sign-on URL: the ACS URL from the drawer. Audience URI (SP Entity ID): the value from the drawer. Name ID format: EmailAddress. Application username: Okta username.
3. Group Attribute Statements: name `groups`, filter Matches regex `.*`.
4. Copy the app's Identity Provider metadata URL into IdP metadata URL in ICC and press Import. This fills the entity ID, sign-on URL and certificate. Press Save and test, then switch Enabled on.

Defaults: subject attribute `nameid`, email `email`, groups `groups`. Assertions must be signed unless you turn that off. IdP-initiated sign-in is refused unless Allow IdP-initiated sign-in is on; it lands on the home page.

## Management API (Okta)

The Management API lets ICC search Okta groups and users when you add them, resolve group ids, and sync membership on a schedule.

1. In Okta Admin, Security > API > Tokens > Create token. Use an account that can read users and groups. Okta expires a token after 30 days without use, so the sync interval keeps it alive; if the sync stays off for a month the token must be replaced.
2. In ICC set Management API kind to Okta, Base URL to the Okta org, paste the token, choose the sync interval (5 to 1440 minutes) and decide whether to deactivate removed users.
3. Sync now runs one pass and the table below the button lists the last ten runs. A failing sync raises an "IdP sync failed" alert.

Without a token the pickers become plain text inputs: type the group name exactly as in Okta, or the user's email address.

## Secrets

The client secret, the Management API token and the SP signing key are stored encrypted and are never returned by the API. A field shows "saved" when a value exists. Leave it blank to keep it, type to replace it, or use Clear. Changing the issuer clears the saved client secret, and changing the Management API base URL clears the saved token, so a stored secret only goes to the address it was saved for.

## Sign-in error codes

The login page shows these when the server redirects back with `?error=<code>`.

| Code | Text shown | Usual cause |
| --- | --- | --- |
| sso_provider | That sign-in option is not available. | Slug unknown or provider disabled. |
| sso_state | The sign-in attempt expired. Try again. | More than 10 minutes between start and return, or a reused link. |
| sso_token | The identity provider's answer could not be verified. | Token request refused: wrong client secret or redirect URI. |
| sso_idtoken | Same as above. | ID token failed signature, issuer, audience or nonce checks. |
| sso_signature | Same as above. | SAML signature invalid: stale certificate in ICC. |
| sso_assertion | Same as above. | SAML assertion failed validation (audience, time window). |
| sso_no_access | Your account is not in any group that has access to this dashboard. | No linked group matches and the user is not pinned. |
| sso_inactive | Your account is disabled. | The user is inactive in ICC or in Okta. |
| sso_jit_disabled | Your account has not been added to this dashboard yet. | Create users on first sign-in is off. |
| sso_unavailable | The identity provider is unreachable. | Network or DNS from ICC to the provider. |
| sso_replay | That sign-in response was already used. | The same SAML response was submitted twice. |

Each failure is logged as `[sso] <slug> <code>: <detail>` and as `[idp] login.failed provider=<slug> code=<code>`. The icc-phase1 build has no audit log, so provider changes and SSO logins appear in the server log only.

## Troubleshooting

- Save and test fails on discovery: the Issuer URL must match the `issuer` in `<issuer>/.well-known/openid-configuration` exactly, apart from a trailing slash.
- Signed in but no access: the groups claim is missing or the name differs. Check Okta's groups claim filter and compare the linked group name with the Okta group name.
- More than 100 groups: Okta truncates the claim. Turn on the Management API and link groups through the picker so the sync supplies membership.
- Redirect URI mismatch at Okta: the URL came from the browser host. Set `icc_base_url` and copy the URLs again.
- Enabled switch is greyed out: run Save and test and get a clean result first.
- A deleted provider removes its linked groups and their grants. Users stay and lose access until another source supplies it.
