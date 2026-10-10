# Device pairing UI evidence

All credentials and server addresses shown here are synthetic browser-test fixtures.

- `before-current-main.png`: the current-main Advanced settings component before the pairing UI was restored.
- `after-pairing-link.png`: the owner creates a one-time fragment link and a locally rendered QR code.
- `after-expiry.png`: the link, QR code, and copy action disappear when the credential expires.
- `pairing-interaction.mp4`: an actual Playwright recording of the existing owner pairing browser case, showing link creation, copy feedback, and removal when the fixture changes from owner to client.

The recording uses the actual component with mocked authentication and clipboard boundaries. It contains no live credential. The recording is cropped to the settings content and trimmed to the interaction; playback remains at normal speed.
