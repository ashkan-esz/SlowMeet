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
USER lowmeet
EXPOSE 8080
ENTRYPOINT ["/app/lowmeet"]
