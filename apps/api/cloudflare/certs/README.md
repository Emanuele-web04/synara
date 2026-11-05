# Supabase database certificate

`supabase-root-2021.crt` is the public root CA linked by the Synara Supabase
dashboard under Database → Settings → SSL configuration. It is not a private key.

Source: <https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt>.
Downloaded 2026-09-28; validity ends 2031-04-26. SHA-256 fingerprint:

```text
80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
```

OpenSSL verified the actual trial pooler chain and hostname with this CA.
The default local CA store rejected that chain. The API's PostgreSQL driver
loads this file only when `DATABASE_URL` specifies `sslrootcert`; it does not
change the machine trust store or disable hostname verification.

Re-download from the authenticated project dashboard if Supabase rotates its
database CA, verify the new chain/hostname, then rebuild the container.
