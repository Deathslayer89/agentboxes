#!/bin/sh
# agentbox guest agent: PID 1 inside a Firecracker VM. One line in, one line out, over the serial console.
#   EXEC <id> <timeoutSeconds> <base64 shell script>   -> RESULT <id> <exitCode> <base64 stdout|-> <base64 stderr|->
#   SEED <base64 random bytes>                           -> SEEDED      (fresh entropy after a snapshot restore)
#   PING                                                 -> PONG
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t devtmpfs dev /dev 2>/dev/null
mount -t tmpfs -o size=${AGENTBOX_DISK_MB:-1024}m,mode=0755 tmpfs /workspace
mount -t tmpfs -o size=256m,mode=1777 tmpfs /tmp
chown 65534:65534 /workspace
# Raw console: no echo of our input back onto the output, and no 4096 byte line limit.
stty -echo -icanon -isig
cd /workspace
echo "AGENTBOX-READY"
while read -r kind a b c; do
  case "$kind" in
    EXEC)
      echo "$c" | base64 -d > /tmp/.cmd.sh
      chmod 644 /tmp/.cmd.sh
      timeout -s KILL "$b" setpriv --reuid=65534 --regid=65534 --clear-groups sh /tmp/.cmd.sh > /tmp/.out 2> /tmp/.err < /dev/null
      code=$?
      out=$(base64 -w0 /tmp/.out)
      err=$(base64 -w0 /tmp/.err)
      echo "RESULT $a $code ${out:--} ${err:--}"
      ;;
    SEED)
      echo "$a" | base64 -d > /dev/urandom
      echo "SEEDED"
      ;;
    PING)
      echo "PONG"
      ;;
  esac
done
