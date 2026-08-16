# Guppy Executor — sandboxed task execution environment
# Built as: docker build -t guppy/executor:latest docker/executor
#
# Contains the toolchain the verification engine shells into:
# node/npx (tsc, vitest, eslint via npx), git, and basic build tools.

FROM node:22-bookworm-slim

# git for worktree operations inside the container, procps for process
# management, python3/make/g++ for native module builds during `npm install`
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        procps \
        ca-certificates \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# pnpm for repos that use it; corepack ships with node 22
RUN corepack enable && corepack prepare pnpm@latest --activate

# Non-root execution user matching the WorkspaceManager's expectations
RUN useradd --create-home --shell /bin/bash guppy \
    && mkdir -p /workspace \
    && chown guppy:guppy /workspace

USER guppy
WORKDIR /workspace

# Keep the container alive; WorkspaceManager execs commands into it
CMD ["sleep", "infinity"]
