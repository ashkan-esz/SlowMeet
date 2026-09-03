FROM golang:1.23-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/lowmeet .

FROM alpine:3.20
RUN adduser -D -H -u 10001 lowmeet
WORKDIR /app
COPY --from=build /out/lowmeet /app/lowmeet
COPY web /app/web
RUN mkdir -p /app/data && chown -R lowmeet:lowmeet /app
USER lowmeet
EXPOSE 8080
EXPOSE 50000-50100/udp
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/app/lowmeet"]
