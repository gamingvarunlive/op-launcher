# Releasing Op Launcher

1. Put the launcher files in a PUBLIC GitHub repo named `op-launcher` (owner is set in package.json > build > publish).
2. Make sure `.github/workflows/release.yml` exists in that repo.
3. To publish a version: change "version" in package.json (for example 1.0.1), commit it, then create a GitHub Release
   with the tag `v1.0.1` (the tag must be `v` + the version in package.json).
4. GitHub Actions builds `Op-Launcher-Setup-1.0.1.exe` and attaches it to the release (about 5 minutes).
5. Everyone who has Op Launcher installed gets the "Update available" window with Update now / Remind me later.

Try the update window without releasing anything (PowerShell):
    $env:OP_FAKE_UPDATE="1.0.1"; npm start
