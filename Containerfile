FROM golang:1.23-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/slowmeet .

FROM alpine:3.20
RUN addgroup -S -g 10001 slowmeet \
  && adduser -S -D -H -u 10001 -G slowmeet slowmeet
WORKDIR /app
COPY --from=build --chown=10001:10001 /out/slowmeet /app/slowmeet
RUN mkdir -p /app/data && chown 10001:10001 /app/data
USER 10001:10001
EXPOSE 8080
EXPOSE 50000-50100/udp
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/slowmeet"]
