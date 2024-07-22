FROM amazonlinux

RUN dnf install -y \
    curl-minimal \
    git \
    git-lfs \
    tar \
    xz

RUN curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && \
    dnf install -y nodejs && \
    dnf clean -y all

RUN corepack enable

WORKDIR /solarwinds-apm
ENTRYPOINT ["/bin/bash", "-c"]
