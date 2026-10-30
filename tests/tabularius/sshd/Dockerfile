# A real OpenSSH server for the Tabularius tests: account "tab", its authorized key from $AUTHORIZED_KEY, and a file with a
# credential to check masking.
FROM alpine:3
RUN apk add --no-cache openssh && adduser -D tab && passwd -u tab && ssh-keygen -A \
  && printf 'host: db.local\npassword: hunter9\n' > /home/tab/app.env && chown tab /home/tab/app.env
CMD ["sh", "-c", "mkdir -p /home/tab/.ssh && printf '%s\\n' \"$AUTHORIZED_KEY\" > /home/tab/.ssh/authorized_keys && chown -R tab /home/tab/.ssh && chmod 700 /home/tab/.ssh && chmod 600 /home/tab/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e -p 2222"]
