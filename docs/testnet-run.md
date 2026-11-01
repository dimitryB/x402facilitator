# Live testnet runs

Each section is one run of `scripts/testnet-run.sh --go` against Hemi testnet (`eip155:743111`).

## Run on 2026-10-29T19:18:01Z: usdc

Facilitator image `hemi-x402-facilitator:e75adda-hemi.8`.

| Payment | Settlement tx | Receipt |
|------|------|------|
| USDC.e `0xD47971C7F5B1067d25cd45d30b2c9eb60de96443` (Permit2) | [`0x0bca64a7f81d3472697852739ab6cb005ff5b08de82c727c997f7e137e3fb6c5`](https://testnet.explorer.hemi.xyz/tx/0x0bca64a7f81d3472697852739ab6cb005ff5b08de82c727c997f7e137e3fb6c5) | status=0x1 block=7099222 from=0xd2b2fc8093f8a734c42b90762fd2b2f8464631af to=0x402085c248eea27d92e8b30b2c58ed07f9e20001, tip 1000000 wei |

The facilitator signer is `0xD2B2fc8093f8A734c42B90762FD2B2F8464631af`; the buyer is `0x35C8182E886382D1133a3Daf980470D3646D3786`; payTo is `0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f`.

Seller log: each payment is verified by the facilitator's /verify, then settled by its /settle:

```
[seller] verified 1000 of 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786
[seller] settled 1000 of 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786: tx 0x0bca64a7f81d3472697852739ab6cb005ff5b08de82c727c997f7e137e3fb6c5
```

Buyer output:

```
pay-usdc: [buyer] buyer 0x35C8182E886382D1133a3Daf980470D3646D3786 holds 22.562078 USDC.e
pay-usdc: [buyer] GET http://localhost:4021/echo?run=testnet&asset=usdc
pay-usdc: [buyer] paying 1000 base units of USDC.e (0xD47971C7F5B1067d25cd45d30b2c9eb60de96443) on eip155:743111 to 0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f via permit2
pay-usdc: [buyer] approve(Permit2, max) sent: 0x891541b7de5e1f023e16403699eae2c279b8e0381b05484463eb30cefb61897b
pay-usdc: [buyer]   https://testnet.explorer.hemi.xyz/tx/0x891541b7de5e1f023e16403699eae2c279b8e0381b05484463eb30cefb61897b
pay-usdc: [buyer] asset:    USDC.e 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 (eip155:743111)
pay-usdc: [buyer] response: {"echo":{"run":"testnet","asset":"usdc"},"timestamp":"2026-10-29T19:17:51.560Z"}
pay-usdc: [buyer] tx:       0x0bca64a7f81d3472697852739ab6cb005ff5b08de82c727c997f7e137e3fb6c5
pay-usdc: [buyer] explorer: https://testnet.explorer.hemi.xyz/tx/0x0bca64a7f81d3472697852739ab6cb005ff5b08de82c727c997f7e137e3fb6c5
pay-usdc: [buyer] buyer balance: 22.562078 USDC.e -> 22.561078 USDC.e
pay-usdc: [buyer] payTo balance: 0 USDC.e -> 0.001 USDC.e
```

## Run on 2026-11-01T19:55:24Z: btc

Facilitator image `hemi-x402-facilitator:e75adda-hemi.9`.

| Payment | Settlement tx | Receipt |
|------|------|------|
| hBTC `0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7` (Permit2) | [`0x5f511cb01e0bae8d8f07707cb6056e2423a1cf4b533e343630bda57d505dfb0d`](https://testnet.explorer.hemi.xyz/tx/0x5f511cb01e0bae8d8f07707cb6056e2423a1cf4b533e343630bda57d505dfb0d) | status=0x1 block=7121009 from=0xd2b2fc8093f8a734c42b90762fd2b2f8464631af to=0x402085c248eea27d92e8b30b2c58ed07f9e20001, tip 1000000 wei |

The facilitator signer is `0xD2B2fc8093f8A734c42B90762FD2B2F8464631af`; the buyer is `0x35C8182E886382D1133a3Daf980470D3646D3786`; payTo is `0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f`.

Seller log: each payment is verified by the facilitator's /verify, then settled by its /settle:

```
[seller] verified 1 of 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786
[seller] settled 1 of 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786: tx 0x5f511cb01e0bae8d8f07707cb6056e2423a1cf4b533e343630bda57d505dfb0d
```

Buyer output:

```
pay-btc: [buyer] buyer 0x35C8182E886382D1133a3Daf980470D3646D3786 holds 0.0009 hBTC
pay-btc: [buyer] GET http://localhost:4021/echo?run=testnet&asset=btc
pay-btc: [buyer] paying 1 base units of hBTC (0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7) on eip155:743111 to 0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f via permit2
pay-btc: [buyer] approve(Permit2, max) sent: 0x5d22a88db9f310aa61260132d37f3f19dc8a04034f6132398d3a9516c0ceb9c1
pay-btc: [buyer]   https://testnet.explorer.hemi.xyz/tx/0x5d22a88db9f310aa61260132d37f3f19dc8a04034f6132398d3a9516c0ceb9c1
pay-btc: [buyer] asset:    hBTC 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 (eip155:743111)
pay-btc: [buyer] response: {"echo":{"run":"testnet","asset":"btc"},"timestamp":"2026-11-01T19:55:14.960Z"}
pay-btc: [buyer] tx:       0x5f511cb01e0bae8d8f07707cb6056e2423a1cf4b533e343630bda57d505dfb0d
pay-btc: [buyer] explorer: https://testnet.explorer.hemi.xyz/tx/0x5f511cb01e0bae8d8f07707cb6056e2423a1cf4b533e343630bda57d505dfb0d
pay-btc: [buyer] buyer balance: 0.0009 hBTC -> 0.00089999 hBTC
pay-btc: [buyer] payTo balance: 0 hBTC -> 0.00000001 hBTC
```

## Run on 2026-11-01T20:41:30Z: usdc btc

Facilitator image `hemi-x402-facilitator:e75adda-hemi.10`.

| Payment | Settlement tx | Receipt |
|------|------|------|
| USDC.e `0xD47971C7F5B1067d25cd45d30b2c9eb60de96443` (Permit2) | [`0x97ecdf92a57a57ca59ebcbef0da4286edfda040811f128051297c407e54c9698`](https://testnet.explorer.hemi.xyz/tx/0x97ecdf92a57a57ca59ebcbef0da4286edfda040811f128051297c407e54c9698) | status=0x1 block=7121238 from=0xd2b2fc8093f8a734c42b90762fd2b2f8464631af to=0x402085c248eea27d92e8b30b2c58ed07f9e20001, tip 1000000 wei |
| hBTC `0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7` (Permit2) | [`0xfafc0f4573cb6917a07bd73094eae20a45f310eeb0a567a68962758ec51c9563`](https://testnet.explorer.hemi.xyz/tx/0xfafc0f4573cb6917a07bd73094eae20a45f310eeb0a567a68962758ec51c9563) | status=0x1 block=7121239 from=0xd2b2fc8093f8a734c42b90762fd2b2f8464631af to=0x402085c248eea27d92e8b30b2c58ed07f9e20001, tip 1000000 wei |

The facilitator signer is `0xD2B2fc8093f8A734c42B90762FD2B2F8464631af`; the buyer is `0x35C8182E886382D1133a3Daf980470D3646D3786`; payTo is `0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f`.

Seller log: each payment is verified by the facilitator's /verify, then settled by its /settle:

```
[seller] verified 1000 of 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786
[seller] settled 1000 of 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786: tx 0x97ecdf92a57a57ca59ebcbef0da4286edfda040811f128051297c407e54c9698
[seller] verified 1 of 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786
[seller] settled 1 of 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786: tx 0xfafc0f4573cb6917a07bd73094eae20a45f310eeb0a567a68962758ec51c9563
```

Buyer output:

```
pay-usdc: [buyer] buyer 0x35C8182E886382D1133a3Daf980470D3646D3786 holds 22.561078 USDC.e
pay-usdc: [buyer] GET http://localhost:4021/echo?run=testnet&asset=usdc
pay-usdc: [buyer] paying 1000 base units of USDC.e (0xD47971C7F5B1067d25cd45d30b2c9eb60de96443) on eip155:743111 to 0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f via permit2
pay-usdc: [buyer] Permit2 allowance ok (115792089237316195423570985008687907853269984665640564039457584007913129639935)
pay-usdc: [buyer] asset:    USDC.e 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 (eip155:743111)
pay-usdc: [buyer] response: {"echo":{"run":"testnet","asset":"usdc"},"timestamp":"2026-11-01T20:41:03.469Z"}
pay-usdc: [buyer] tx:       0x97ecdf92a57a57ca59ebcbef0da4286edfda040811f128051297c407e54c9698
pay-usdc: [buyer] explorer: https://testnet.explorer.hemi.xyz/tx/0x97ecdf92a57a57ca59ebcbef0da4286edfda040811f128051297c407e54c9698
pay-usdc: [buyer] buyer balance: 22.561078 USDC.e -> 22.560078 USDC.e
pay-usdc: [buyer] payTo balance: 0.001 USDC.e -> 0.002 USDC.e
pay-btc: [buyer] buyer 0x35C8182E886382D1133a3Daf980470D3646D3786 holds 0.00089999 hBTC
pay-btc: [buyer] GET http://localhost:4021/echo?run=testnet&asset=btc
pay-btc: [buyer] paying 1 base units of hBTC (0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7) on eip155:743111 to 0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f via permit2
pay-btc: [buyer] Permit2 allowance ok (115792089237316195423570985008687907853269984665640564039457584007913129639935)
pay-btc: [buyer] asset:    hBTC 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 (eip155:743111)
pay-btc: [buyer] response: {"echo":{"run":"testnet","asset":"btc"},"timestamp":"2026-11-01T20:41:14.662Z"}
pay-btc: [buyer] tx:       0xfafc0f4573cb6917a07bd73094eae20a45f310eeb0a567a68962758ec51c9563
pay-btc: [buyer] explorer: https://testnet.explorer.hemi.xyz/tx/0xfafc0f4573cb6917a07bd73094eae20a45f310eeb0a567a68962758ec51c9563
pay-btc: [buyer] buyer balance: 0.00089999 hBTC -> 0.00089998 hBTC
pay-btc: [buyer] payTo balance: 0.00000001 hBTC -> 0.00000002 hBTC
```

## Run on 2026-11-01T22:21:14Z: usdc btc

Facilitator image `hemi-x402-facilitator:e75adda-hemi.11`.

| Payment | Settlement tx | Receipt |
|------|------|------|
| USDC.e `0xD47971C7F5B1067d25cd45d30b2c9eb60de96443` (Permit2) | [`0xf72346bea38dd423109a786e65969682c5d85780297d26dcb821fab059d06bb8`](https://testnet.explorer.hemi.xyz/tx/0xf72346bea38dd423109a786e65969682c5d85780297d26dcb821fab059d06bb8) | status=0x1 block=7121737 from=0xd2b2fc8093f8a734c42b90762fd2b2f8464631af to=0x402085c248eea27d92e8b30b2c58ed07f9e20001, tip 1000000 wei |
| hBTC `0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7` (Permit2) | [`0x42ec5319355db2357a66c27964854cfa2bff1cf4f8b186caa6a274ae9780eac2`](https://testnet.explorer.hemi.xyz/tx/0x42ec5319355db2357a66c27964854cfa2bff1cf4f8b186caa6a274ae9780eac2) | status=0x1 block=7121738 from=0xd2b2fc8093f8a734c42b90762fd2b2f8464631af to=0x402085c248eea27d92e8b30b2c58ed07f9e20001, tip 1000000 wei |

The facilitator signer is `0xD2B2fc8093f8A734c42B90762FD2B2F8464631af`; the buyer is `0x35C8182E886382D1133a3Daf980470D3646D3786`; payTo is `0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f`.

Seller log: each payment is verified by the facilitator's /verify, then settled by its /settle:

```
[seller] verified 1000 of 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786
[seller] settled 1000 of 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786: tx 0xf72346bea38dd423109a786e65969682c5d85780297d26dcb821fab059d06bb8
[seller] verified 1 of 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786
[seller] settled 1 of 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 on eip155:743111 from 0x35C8182E886382D1133a3Daf980470D3646D3786: tx 0x42ec5319355db2357a66c27964854cfa2bff1cf4f8b186caa6a274ae9780eac2
```

Buyer output:

```
pay-usdc: [buyer] buyer 0x35C8182E886382D1133a3Daf980470D3646D3786 holds 22.560078 USDC.e
pay-usdc: [buyer] GET http://localhost:4021/echo?run=testnet&asset=usdc
pay-usdc: [buyer] paying 1000 base units of USDC.e (0xD47971C7F5B1067d25cd45d30b2c9eb60de96443) on eip155:743111 to 0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f via permit2
pay-usdc: [buyer] Permit2 allowance ok (115792089237316195423570985008687907853269984665640564039457584007913129639935)
pay-usdc: [buyer] asset:    USDC.e 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 (eip155:743111)
pay-usdc: [buyer] response: {"echo":{"run":"testnet","asset":"usdc"},"timestamp":"2026-11-01T22:20:53.376Z"}
pay-usdc: [buyer] tx:       0xf72346bea38dd423109a786e65969682c5d85780297d26dcb821fab059d06bb8
pay-usdc: [buyer] explorer: https://testnet.explorer.hemi.xyz/tx/0xf72346bea38dd423109a786e65969682c5d85780297d26dcb821fab059d06bb8
pay-usdc: [buyer] buyer balance: 22.560078 USDC.e -> 22.559078 USDC.e
pay-usdc: [buyer] payTo balance: 0.002 USDC.e -> 0.003 USDC.e
pay-btc: [buyer] buyer 0x35C8182E886382D1133a3Daf980470D3646D3786 holds 0.00089998 hBTC
pay-btc: [buyer] GET http://localhost:4021/echo?run=testnet&asset=btc
pay-btc: [buyer] paying 1 base units of hBTC (0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7) on eip155:743111 to 0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f via permit2
pay-btc: [buyer] Permit2 allowance ok (115792089237316195423570985008687907853269984665640564039457584007913129639935)
pay-btc: [buyer] asset:    hBTC 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 (eip155:743111)
pay-btc: [buyer] response: {"echo":{"run":"testnet","asset":"btc"},"timestamp":"2026-11-01T22:21:04.945Z"}
pay-btc: [buyer] tx:       0x42ec5319355db2357a66c27964854cfa2bff1cf4f8b186caa6a274ae9780eac2
pay-btc: [buyer] explorer: https://testnet.explorer.hemi.xyz/tx/0x42ec5319355db2357a66c27964854cfa2bff1cf4f8b186caa6a274ae9780eac2
pay-btc: [buyer] buyer balance: 0.00089998 hBTC -> 0.00089997 hBTC
pay-btc: [buyer] payTo balance: 0.00000002 hBTC -> 0.00000003 hBTC
```
