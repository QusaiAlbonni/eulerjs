# Changesets

Each file here describes a change for the next release: which packages it bumps, by how much,
and a line for their changelogs. Add one with `npm run changeset` alongside the change itself.

On every push to `main`, the release workflow (`.github/workflows/release.yml`) keeps a
"Version Packages" pull request open with the bumped versions and changelogs. Merging it
publishes those packages to npm and makes a GitHub release for each. Nothing is published until
then, and a commit without a changeset releases nothing.

The plugins take `@eulerjs/core` as a peer dependency, and are bumped with it only when its new
version falls outside their range (`onlyUpdatePeerDependentsWhenOutOfRange`): below 1.0, a
minor release of core is outside `^0.x.0`, a patch release is not.
