# Tezca relay server image.
# The build context is the server/ directory:
#   docker build -f deploy/Dockerfile -t tezca-server server      (from the repo root)
# The compose files in this directory do this for you.
ARG GO_VERSION=1.27

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/tezca-server ./cmd/tezca-server \
 && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/tezca-server /tezca-server
# Pre-create the data dir owned by the nonroot user (65532) so a fresh named volume is writable.
COPY --from=build --chown=65532:65532 /out/data /data
ENV TEZCA_DATA_DIR=/data \
    TEZCA_LISTEN=:8080
USER 65532:65532
VOLUME /data
EXPOSE 8080
# Exec form: distroless has no shell, so the binary has its own probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["/tezca-server", "healthcheck"]
ENTRYPOINT ["/tezca-server"]
