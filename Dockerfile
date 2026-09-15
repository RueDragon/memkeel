# Memkeel, containerised.
#
# The image is deliberately minimal: an official Node image and nothing else. The core system
# has zero runtime npm dependencies and the web console bundle is committed, so there is no
# install step, no build step and no Obsidian dependency here.
#
# Storage: the `filesystem` backend only. `obsidian-cli` needs an installed, running Obsidian
# GUI, which does not exist in a container, so it is out of scope for this image.
FROM node:22-slim

# Pinned so a later `docker build` cannot silently drop below the supported runtime
# (package.json engines: node >= 22.18).
RUN node -e "const [maj,min]=process.versions.node.split('.').map(Number); \
  if (maj < 22 || (maj === 22 && min < 18)) { \
    console.error('Memkeel needs Node >= 22.18, found ' + process.versions.node); process.exit(1); \
  }"

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
COPY dashboard/ ./dashboard/
COPY bootstrap.md event-schema.md config.example.json ./

# The memory home holds config.json, bootstrap.md, event-schema.md, state/ and backups/.
# The store (vaultRoot) holds the event journal and every projection — the actual data.
#
# First run, which creates the home and points the store at the mounted volume:
#   docker run --rm \
#     -v memkeel-home:/memkeel \
#     -v "$PWD/store:/store" \
#     memkeel init --store /store
#
# Mount BOTH: /memkeel is the configuration and derived state, /store is the Markdown you would
# be sad to lose. Never bake a config, a store or a credential into the image.
ENV MEMKEEL_HOME=/memkeel
RUN mkdir -p /memkeel /store

# Afterwards the default command is the health check; override it with any other command:
#   docker run --rm -v memkeel-home:/memkeel -v "$PWD/store:/store" memkeel doctor
#   docker run --rm -v memkeel-home:/memkeel -v "$PWD/store:/store" memkeel \
#     bootstrap --cwd /store --query "release checklist"
ENTRYPOINT ["node", "memory.mjs"]
CMD ["doctor"]
