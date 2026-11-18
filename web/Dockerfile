# Kwazat web front: the waiting page, robots.txt and security.txt (see web/Caddyfile).
FROM caddy:2.10-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY public /srv
ENV PORT=8080
EXPOSE 8080
