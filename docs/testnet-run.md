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
