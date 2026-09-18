# Memkeel, containerised.
#
# The image is deliberately minimal: an official Node image and nothing else. The core system
# has zero runtime npm dependencies and the web console bundle is committed, so there is no
# install step, no build step and no Obsidian dependency here.
#
# Storage: the `filesystem` backend only. `obsidian-cli` needs an installed, running Obsidian
# GUI, which does not exist in a container, so it is out of scope for this image.
#
# Verification status: the file set below and the command contract in the comments are covered by
# tests that run against the published package (`npm pack`, unpacked into an empty directory), and a
# test asserts that every path copied here exists and that `dashboard/app` is not copied. The image
# build and a container run are covered by the `docker` job in `.github/workflows/ci.yml`, which builds
# this image and runs the documented commands - `init`, `workspace-add`, `register`, `record`, `recall`,
# `bootstrap` and `doctor` - against synthetic data in the runner's temporary directory, under the
# non-root identity described below, and asserts that the artifacts it leaves on the host are owned by
# the invoking uid. No registry, no push, no secret, and nothing mounted from a real memory home, a real
# host configuration or a real knowledge base.
FROM node:22-slim

# Pinned so a later `docker build` cannot silently drop below the supported runtime
# (package.json engines: node >= 22.18).
RUN node -e "const [maj,min]=process.versions.node.split('.').map(Number); \
  if (maj < 22 || (maj === 22 && min < 18)) { \
    console.error('Memkeel needs Node >= 22.18, found ' + process.versions.node); process.exit(1); \
  }"

# `git` is the one external program this system shells out to: workspace identity comes from a
# repository's common directory, so `workspace-add --cwd DIR`, `bootstrap --cwd DIR` and worktree
# resolution all run `git rev-parse` underneath. Without it the image cannot run the commands its own
# comments document - it fails with "Workspace discovery failed" and the only way to register a
# workspace is to edit the configuration by hand. The apt lists are removed in the same layer so the
# image does not carry a package index it will never use again.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Package metadata first so a source-only edit does not invalidate the cached layer.
COPY package.json ./

# Everything the runtime needs. No node_modules: there are no runtime dependencies.
COPY memory.mjs mcp-server.mjs hook-runner.mjs dsh-memory-plugin.mjs \
     setup.mjs publish.mjs integrate-mcp.mjs integrate-hooks.mjs dashboard.mjs ./
COPY bin/ ./bin/
COPY lib/ ./lib/
COPY scripts/ ./scripts/
COPY vendor/ ./vendor/
# Only the built console, not `dashboard/app`: the Vite source and its lockfile are development
# material, and `package.json` "files" excludes them from the published package for the same reason.
# The image therefore ships exactly what `npm pack` ships.
COPY dashboard/static/ ./dashboard/static/
COPY bootstrap.md event-schema.md config.example.json ./

# The memory home holds config.json, bootstrap.md, event-schema.md, state/ and backups/.
# The store (vaultRoot) holds the event journal and every projection — the actual data.
#
# First run, which creates the home and points the store at the mounted volume. The `--user` flag and
# bind mounts are the supported form, for the reason spelled out under "Running as whom" below:
#   docker run --rm --user "$(id -u):$(id -g)" \
#     -v "$PWD/memory-home:/memkeel" -v "$PWD/store:/store" \
#     memkeel init --store /store
#
# Mount BOTH: /memkeel is the configuration and derived state, /store is the Markdown you would
# be sad to lose. Never bake a config, a store or a credential into the image.
#
# Registering a project works in here because the image ships `git`, and it needs the repository
# mounted: workspace identity is derived from the repository's common directory, not from a name.
#   docker run --rm --user "$(id -u):$(id -g)" \
#     -v "$PWD/memory-home:/memkeel" -v "$PWD/store:/store" -v "$PWD/my-project:/project" \
#     memkeel workspace-add --cwd /project
#   docker run --rm --user "$(id -u):$(id -g)" \
#     -v "$PWD/memory-home:/memkeel" -v "$PWD/store:/store" -v "$PWD/my-project:/project" \
#     memkeel bootstrap --cwd /project --query "release checklist"
#
# Running as whom
# ---------------
# This image sets no USER, so `docker run` without `--user` runs as root. That default is only right for
# a read-only check: a root container writing through a mount leaves root-owned files in the host
# directory it was pointed at, and in a knowledge base that is the directory you then cannot edit
# yourself. The supported way to run anything that writes is to hand the container your own ids, as in
# the commands above. No volume is ever chowned by this program or this image: the container writes as
# that uid because the bind-mounted directory already belongs to it.
#
# That is also why a *named* volume cannot be used with `--user`: Docker creates it from the image, so it
# is root-owned and an unprivileged uid cannot write to it. The choice is a directory you own together
# with `--user`, or root together with a named volume.
#
# HOME is /tmp so that a run under an arbitrary uid has somewhere writable to look. This program keeps
# nothing in $HOME: the memory home is MEMKEEL_HOME.
ENV MEMKEEL_HOME=/memkeel
ENV HOME=/tmp
RUN mkdir -p /memkeel /store

# Afterwards the default command is the health check; override it with any other command:
#   docker run --rm --user "$(id -u):$(id -g)" \
#     -v "$PWD/memory-home:/memkeel" -v "$PWD/store:/store" memkeel doctor
#
# `doctor` is read-only apart from its own derived state, so it is also the one command that is safe
# against a store you mounted read-only. Note that `bootstrap --cwd` reads a *project* directory: the
# store is not a project, and passing it says nothing about which workspace a run belongs to.
ENTRYPOINT ["node", "memory.mjs"]
CMD ["doctor"]
