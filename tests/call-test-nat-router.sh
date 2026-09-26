#!/bin/sh
set -eu

# These rules live only in this disposable router's network namespace.
wan=$(ip -o -4 addr show | awk -v ip="$PUBLIC_IP/24" '$4 == ip {print $2}')
lan=$(ip -o -4 addr show | awk -v ip="$GATEWAY_IP/24" '$4 == ip {print $2}')
test -n "$wan"
test -n "$lan"
iptables -P FORWARD DROP
iptables -N CALL_MEDIA
iptables -N CALL_WAN_UDP
iptables -A CALL_WAN_UDP -j ACCEPT
iptables -A FORWARD -p udp --dport 4102:4133 -j CALL_MEDIA
iptables -A FORWARD -i "$wan" -o "$lan" -p udp -s 172.29.203.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j CALL_WAN_UDP
iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FORWARD -i "$lan" -o "$wan" -d 172.29.203.0/24 -j ACCEPT
iptables -A FORWARD -d "$NODE_IP" -m conntrack --ctstate DNAT -j ACCEPT
iptables -t nat -A POSTROUTING -o "$wan" -s "$LAN_SUBNET" -j SNAT --to-source "$PUBLIC_IP"
# Hairpin traffic: a local browser uses its own node's advertised TURN address.
iptables -t nat -A POSTROUTING -o "$lan" -s "$LAN_SUBNET" -d "$NODE_IP" -j SNAT --to-source "$GATEWAY_IP"
for protocol in tcp udp; do
  iptables -t nat -A PREROUTING -d "$PUBLIC_IP" -p "$protocol" --dport 4101:4133 -j DNAT --to-destination "$NODE_IP"
done
# Playwright control only; no application data travels over this connection.
iptables -t nat -A PREROUTING -d "$PUBLIC_IP" -p tcp --dport 9222 -j DNAT --to-destination "$NODE_IP"
touch /tmp/router-ready
exec sleep infinity
