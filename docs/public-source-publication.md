# Public source snapshot

This repository starts with a new OpenArc-authored root commit. It is not a fork,
transfer or mirror of the private development repository. Private commits, tags,
branches, contributor metadata and Actions history are not included.

## Included and excluded

- Application source, tests, schemas, build configuration and technical documents
  are included. The application implementation matches the M10 hardening candidate
  described in the release ledger; publication is not a new deployed release.
- Personal-account links in historical evidence notes are omitted explicitly.
  Historical commit hashes and test results describe pre-publication evidence;
  those Git objects are not available in this repository.
- Generated PDFs, local environment files, browser profiles, CI artifacts,
  dependencies and temporary tooling are excluded. The logo is a bundled asset.
- Public source availability does not grant an open-source license. The package
  remains UNLICENSED; third-party dependencies retain their own licenses.

## Reproducible checks

The manual **Public source checks** workflow runs the existing Node 22 Docker
source gate: release-contract checks, dependency audit, license policy, lint,
typecheck, unit/integration tests, builds and development browser journeys.
It requires no private repository access, old Git objects or deployment secrets.

The pre-publication release workflow is retained at
[release-gates.reference.yml](engineering/release-gates.reference.yml) as an
architectural reference. It is not installed as a public workflow. Its historical
reader jobs require private RC objects that are deliberately not distributed.
The structural source checker inspects this archived contract; that inspection
does not prove the archived jobs ran in public CI.

Public source checks do not rerun the historical-reader, production-image scan,
SBOM or deployed-service gates. The release ledgers describe earlier evidence;
do not treat a public source-check badge as public-launch approval, an independent
security audit or a complete replacement for those release gates.

## Identity boundary

Public commits must use OpenArc as both author and committer with the designated
project alias. Do not merge private history, publish private tags or include
personal co-author trailers. Check every outgoing commit before pushing.
Run `node scripts/check-public-history.mjs`; public CI also checks the history.
Do not attach the project alias to a personal GitHub account as a verified email:
GitHub can associate commit authors with accounts through matching email addresses.
The GitHub account performing a push or other public action can still be visible
in activity; branded commit metadata is not account anonymity.
