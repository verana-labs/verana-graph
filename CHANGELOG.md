# Changelog

## [1.0.0](https://github.com/verana-labs/verana-graph/compare/v0.1.0...v1.0.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* **search:** snippet field groups and the projection selector ([#37](https://github.com/verana-labs/verana-graph/issues/37))

### Features

* add CD scripts for versioning ([#11](https://github.com/verana-labs/verana-graph/issues/11)) ([f3b1fcb](https://github.com/verana-labs/verana-graph/commit/f3b1fcb5fc3ef939c3b882ee045385d456c16fc6))
* add Helm chart ([#10](https://github.com/verana-labs/verana-graph/issues/10)) ([22f4ed9](https://github.com/verana-labs/verana-graph/commit/22f4ed9485a88d4f15d39eb598e7118037a5574f))
* **docs:** export the OpenAPI document to docs/api/openapi.json ([#55](https://github.com/verana-labs/verana-graph/issues/55)) ([7fae209](https://github.com/verana-labs/verana-graph/commit/7fae2099554bfec7fb904787ec5d59d297ea1172))
* **explorer:** label and badge nodes from the result card fields ([#28](https://github.com/verana-labs/verana-graph/issues/28)) ([a0cf186](https://github.com/verana-labs/verana-graph/commit/a0cf1866db5f161cffd817cdfc0d9f7d9076c6c9))
* graph service implementation (spec v4-draft3) ([#1](https://github.com/verana-labs/verana-graph/issues/1)) ([bc00c3b](https://github.com/verana-labs/verana-graph/commit/bc00c3b64b65faa3d63898eda8b975d039698593))
* **ingest:** vp claims, bound-did text and the TG-IDX-2 indexes ([#36](https://github.com/verana-labs/verana-graph/issues/36)) ([94252b7](https://github.com/verana-labs/verana-graph/commit/94252b736263abbe21c3e6694773dc85c3ba5442))
* openapi docs at /docs served with swagger ui ([#22](https://github.com/verana-labs/verana-graph/issues/22)) ([a03e0d4](https://github.com/verana-labs/verana-graph/commit/a03e0d4823ab0490ae86391fb3256e055937d622))
* paginate the traversal queries per TG-QRY-6 ([#14](https://github.com/verana-labs/verana-graph/issues/14)) ([e1389b9](https://github.com/verana-labs/verana-graph/commit/e1389b9d88630e7bbfbe95be6a78fcb4a74eaf5b))
* refresh the served Did snippet and add operatorRegistryId and operatorAddress ([#31](https://github.com/verana-labs/verana-graph/issues/31)) ([eb93fef](https://github.com/verana-labs/verana-graph/commit/eb93fef0ebd6dd74c4e5ff060a6c4b96c392112c))
* retain non-ACTIVE participants while referenced ([#20](https://github.com/verana-labs/verana-graph/issues/20)) ([a85372a](https://github.com/verana-labs/verana-graph/commit/a85372a2e3cc9d645c5da761fb0aa899b0cfc46c))
* return the TG-FCT-6a result card fields and honour TG-FCT-4a matching ([#27](https://github.com/verana-labs/verana-graph/issues/27)) ([a694d37](https://github.com/verana-labs/verana-graph/commit/a694d37c46b256a138c9a66437e0510a157a77fe))
* **search:** default facets, docs and explorer for the snippet groups ([#39](https://github.com/verana-labs/verana-graph/issues/39)) ([8facbcd](https://github.com/verana-labs/verana-graph/commit/8facbcd0aaeba2ec81cdc0a6ac6751c6f597d0f8))
* **search:** snippet field groups and the projection selector ([#37](https://github.com/verana-labs/verana-graph/issues/37)) ([53aa7b3](https://github.com/verana-labs/verana-graph/commit/53aa7b32c0034a781e8ae1f400fea3c9229cacfd))
* visual graph explorer at /explorer ([#26](https://github.com/verana-labs/verana-graph/issues/26)) ([161a0d7](https://github.com/verana-labs/verana-graph/commit/161a0d7581f135cb7724baec94cbbffefe2b30ab))


### Bug Fixes

* align error responses with the TG-ERR-1 contract ([#13](https://github.com/verana-labs/verana-graph/issues/13)) ([d83a250](https://github.com/verana-labs/verana-graph/commit/d83a2501bd61e43e62db02fa994303df26c66b86))
* anchor the bootstrap on subscribed.block ([#19](https://github.com/verana-labs/verana-graph/issues/19)) ([6ebe81c](https://github.com/verana-labs/verana-graph/commit/6ebe81ced364b8fa9ebe6ae83dd082a0ff8af5f6))
* answer malformed requests with the TG-ERR-1 envelope ([#47](https://github.com/verana-labs/verana-graph/issues/47)) ([1ae7976](https://github.com/verana-labs/verana-graph/commit/1ae7976844d68596cebdce818ed8ed1674afbe38))
* backfill the result card logo columns that 0007 left null ([#32](https://github.com/verana-labs/verana-graph/issues/32)) ([870115f](https://github.com/verana-labs/verana-graph/commit/870115f729c29fc73cd946c96ff0d197f1c5fa5e))
* **chart:** default database storage to 2Gi with a sizing note ([#24](https://github.com/verana-labs/verana-graph/issues/24)) ([bc9c3ef](https://github.com/verana-labs/verana-graph/commit/bc9c3efdf7f3bbe4464da5b137e0fa968c37f8b6))
* **chart:** include postgres db ([#18](https://github.com/verana-labs/verana-graph/issues/18)) ([7108466](https://github.com/verana-labs/verana-graph/commit/7108466f89be010ebeb0be42f225eac91a4253f3))
* **db:** rebuild the graph once so old rows pick up the key fixes ([#52](https://github.com/verana-labs/verana-graph/issues/52)) ([421d1a2](https://github.com/verana-labs/verana-graph/commit/421d1a2ff622057c5c36a6d47f6ffb5045765b81))
* **deref:** verify DataIntegrityProof on linked VPs ([#53](https://github.com/verana-labs/verana-graph/issues/53)) ([92ae685](https://github.com/verana-labs/verana-graph/commit/92ae6855802c6e000e01b9c84df4e18b0e6cb2cb))
* **ingest:** absolutize relative service ids ([#51](https://github.com/verana-labs/verana-graph/issues/51)) ([ac4e2f6](https://github.com/verana-labs/verana-graph/commit/ac4e2f6705df148932d33120809eb88f45f82918))
* **ingest:** keep ingesting when a DID fails to resolve ([#43](https://github.com/verana-labs/verana-graph/issues/43)) ([b7d0319](https://github.com/verana-labs/verana-graph/commit/b7d0319157fe2e68eae64d6e5cec95c129eaae82))
* **ingest:** key ECS credentials by holder and id ([#50](https://github.com/verana-labs/verana-graph/issues/50)) ([ae65b11](https://github.com/verana-labs/verana-graph/commit/ae65b11ac05bf76a60063d7e9e0dfd6edf325e56))
* **ingest:** retry credential schema loads that failed ([#44](https://github.com/verana-labs/verana-graph/issues/44)) ([7e162b8](https://github.com/verana-labs/verana-graph/commit/7e162b8c6e4cb98cabd93a0c642930e177379654))
* openapi spec ([1d6e087](https://github.com/verana-labs/verana-graph/commit/1d6e0878c88739009837b28f1053fdd9aef09c53))
* refresh vendored JSON Schemas to the current spec ([#12](https://github.com/verana-labs/verana-graph/issues/12)) ([020b762](https://github.com/verana-labs/verana-graph/commit/020b7625dafa3cba89a473970e14d96c2c2b2bd1))
* **search:** escape prefix wildcards and hide expired ECS data ([#48](https://github.com/verana-labs/verana-graph/issues/48)) ([53f1743](https://github.com/verana-labs/verana-graph/commit/53f1743408d41e8d2b37cdca5dd77924c1129d1a))
* **search:** gate ServiceEndpoint hits by the owning DID ([#45](https://github.com/verana-labs/verana-graph/issues/45)) ([98200de](https://github.com/verana-labs/verana-graph/commit/98200de344e38579e0a0bbfba54ddd51d78851b0))
* **search:** match freeText as whole tokens per TG-FCT-4a ([#46](https://github.com/verana-labs/verana-graph/issues/46)) ([3a02f13](https://github.com/verana-labs/verana-graph/commit/3a02f134eda3414b830cafeb731040d4501382fe))
* **traverse:** conform A1, A2, B1, B2 and F1 to TG-QRY-3 ([#49](https://github.com/verana-labs/verana-graph/issues/49)) ([9ed7a22](https://github.com/verana-labs/verana-graph/commit/9ed7a22c8272893f7cb36db777a69c7a61f6eab6))
* unparseable request bodies get the INVALID_INPUT envelope ([#25](https://github.com/verana-labs/verana-graph/issues/25)) ([778c120](https://github.com/verana-labs/verana-graph/commit/778c120e0bc73c46e53ec25b62180a53fa0b0899))
* update chart name ([#17](https://github.com/verana-labs/verana-graph/issues/17)) ([1af0930](https://github.com/verana-labs/verana-graph/commit/1af09306a0f536b06bacf6a10a9e584dc3ca9671))


### Miscellaneous Chores

* release 1.0.0 ([5a3e928](https://github.com/verana-labs/verana-graph/commit/5a3e9288aebc1a0c91527d00566c9481ad0556e2))
