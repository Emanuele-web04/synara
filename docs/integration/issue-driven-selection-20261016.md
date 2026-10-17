# Issue-driven integration selection — 2026-10-16

> **Inventory, not evidence of integration or passing CI.** The existing [draft #1878](https://github.com/Emanuele-web04/synara/pull/1878) still contains a historical combined implementation from October 12. This document describes the **new agreed target**. It does **not** certify that all of the current heads are present in its tree or that excluded code has been removed.

## Rules

- Include bug fixes, regressions, issue implementations, incomplete previously requested behavior, platform/compatibility repairs, performance fixes, and essential documentation/tests/migrations that satisfy a real issue or previous PR acceptance criteria, **regardless of `fix`/`feat` prefix**.
- Do not include unrelated standalone functionality merely because it is one of the author's PRs. When a PR mixes repairs with standalone functionality, split/port the issue-driven portion.
- Keep each original PR and authorship intact. Link continuation repairs to their originals. For overlapping implementations, choose the correct combined behavior and verify it, not just both heads' ancestry.
- The checker is a **draft test candidate**. Do not merge/push `main`, close original PRs, or enable auto-merge.
- CI must be verified on the exact combined code commit, in addition to isolated source-head CI. Record uncovered cross-feature interactions and real platform gaps, not only mergeability.

## Snapshot and drift

- Source repository: [Emanuele-web04/synara](https://github.com/Emanuele-web04/synara).
- Upstream main when inventoried: `df87a48b9f2d403e3d2785ef11502f2ce2922f5b`.
- Historical combined head before this inventory: `c8ba86c2c27c9952ef9f9b70750210da5a6776f6`, based on an earlier main (`42fe8a7a66291ce8959bffd20249778752b4601a`).
- There are **75 open work PRs** plus #1878. **70 issue-driven inclusion candidates** and **5 provisional standalone exclusions**.
- Existing #1878 frozen inventory had 67 open PRs at creation; five of those have since merged independently. Several remaining original PR heads changed and 13 newer PRs are not in that frozen inventory.
- These are selection candidates rather than an all-green merge batch. Head SHAs are snapshots and must be refreshed before composing a combined commit.

## Exclude from issue-driven checker unless a concrete prior issue or regression establishes otherwise

| PR                                                          | Reason                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [#1210](https://github.com/Emanuele-web04/synara/pull/1210) | Standalone Cline provider integration; no issue-resolution link established. |
| [#1232](https://github.com/Emanuele-web04/synara/pull/1232) | Standalone favorites/catalog feature stacked on Cline.                       |
| [#1238](https://github.com/Emanuele-web04/synara/pull/1238) | Standalone model-preset feature stacked on favorites.                        |
| [#1937](https://github.com/Emanuele-web04/synara/pull/1937) | Standalone Notion enterprise OAuth integration.                              |
| [#1952](https://github.com/Emanuele-web04/synara/pull/1952) | Standalone Code-OSS extension-host integration stacked on an IDE feature.    |

## Superseding repair chains (apply only once in final integration)

| Original                                                    | Later repair                                                | Required check                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [#1745](https://github.com/Emanuele-web04/synara/pull/1745) | [#1889](https://github.com/Emanuele-web04/synara/pull/1889) | Preserve original functional requirements; integrate newer corrections, with no duplicated implementation. |
| [#1757](https://github.com/Emanuele-web04/synara/pull/1757) | [#1890](https://github.com/Emanuele-web04/synara/pull/1890) | Preserve original functional requirements; integrate newer corrections, with no duplicated implementation. |
| [#1763](https://github.com/Emanuele-web04/synara/pull/1763) | [#1891](https://github.com/Emanuele-web04/synara/pull/1891) | Preserve original functional requirements; integrate newer corrections, with no duplicated implementation. |
| [#1766](https://github.com/Emanuele-web04/synara/pull/1766) | [#1892](https://github.com/Emanuele-web04/synara/pull/1892) | Preserve original functional requirements; integrate newer corrections, with no duplicated implementation. |
| [#1767](https://github.com/Emanuele-web04/synara/pull/1767) | [#1893](https://github.com/Emanuele-web04/synara/pull/1893) | Preserve original functional requirements; integrate newer corrections, with no duplicated implementation. |
| [#1772](https://github.com/Emanuele-web04/synara/pull/1772) | [#1894](https://github.com/Emanuele-web04/synara/pull/1894) | Preserve original functional requirements; integrate newer corrections, with no duplicated implementation. |
| [#1780](https://github.com/Emanuele-web04/synara/pull/1780) | [#1895](https://github.com/Emanuele-web04/synara/pull/1895) | Preserve original functional requirements; integrate newer corrections, with no duplicated implementation. |

Other overlapping lineages include the Linux packaging PRs #1652/#1720/#1823, browser tabs #1790 (already merged)/#1792/#1793, and composer effort/recovery #1770/#1771/#1858. Their final combined behavior requires explicit comparison.

## Current acceptance blockers

- [#1783](https://github.com/Emanuele-web04/synara/pull/1783): latest main CI passed after format correction, but dedicated Electron browser acceptance reported one failing annotation-session test (7 passed / 1 failed).
- [#1938](https://github.com/Emanuele-web04/synara/pull/1938), [#1847](https://github.com/Emanuele-web04/synara/pull/1847), [#1823](https://github.com/Emanuele-web04/synara/pull/1823): marketing visual snapshots fail, including a docs screenshot height mismatch. Do not blindly update baselines without verifying design intent.
- [#1789](https://github.com/Emanuele-web04/synara/pull/1789), [#1768](https://github.com/Emanuele-web04/synara/pull/1768), [#1767](https://github.com/Emanuele-web04/synara/pull/1767), [#1757](https://github.com/Emanuele-web04/synara/pull/1757), [#1720](https://github.com/Emanuele-web04/synara/pull/1720): GitHub reports merge conflicts on original PR branches; later repair continuations may supersede part of their implementation.
- #1878 itself is conflicted against current main and **has not been rebuilt or validated against this target scope**.
- Verify mixed-scope [#1938](https://github.com/Emanuele-web04/synara/pull/1938) and [#1916](https://github.com/Emanuele-web04/synara/pull/1916) carefully: keep the fixes, but do not silently expand the integration checker with unrelated passkey/playbook features.

## Candidate inventory

| PR                                                          | Head SHA at inventory                      | Disposition                   | Source issue / reason                                                                 |
| ----------------------------------------------------------- | ------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------- |
| [#1652](https://github.com/Emanuele-web04/synara/pull/1652) | `82f099ec3ed6dc698e76dac17c93ef4354141f5e` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1655](https://github.com/Emanuele-web04/synara/pull/1655) | `fdb4f6933160f7d0fd60e58c1adb811cf71e4036` | Issue-driven candidate        | #800                                                                                  |
| [#1656](https://github.com/Emanuele-web04/synara/pull/1656) | `4872bbc96884ec050dc4e6ae8eb2ac312019c1d6` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1716](https://github.com/Emanuele-web04/synara/pull/1716) | `fd9fb52094c8af853ba926397c5cb64e7b9ebc51` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1717](https://github.com/Emanuele-web04/synara/pull/1717) | `84d0a5083d1f795925d56f07167ca6a971f51904` | Issue-driven candidate        | #1136                                                                                 |
| [#1718](https://github.com/Emanuele-web04/synara/pull/1718) | `629f5f8b8b3de4dcd9e7005452f564fc4a3efa6a` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1720](https://github.com/Emanuele-web04/synara/pull/1720) | `6e011e0d3e7e2fa6001c2cd98e3d049af1803a9b` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1721](https://github.com/Emanuele-web04/synara/pull/1721) | `91c7bf6b7504e613c5a61200ef30f971579e2c48` | Issue-driven candidate        | #154                                                                                  |
| [#1745](https://github.com/Emanuele-web04/synara/pull/1745) | `62d9043007f43aae78c6a41b6ceee89dd6c1ccb3` | Superseded candidate by #1889 | #405                                                                                  |
| [#1757](https://github.com/Emanuele-web04/synara/pull/1757) | `bccabf0888fd4f274612ab6ecddb07d721c3151a` | Superseded candidate by #1890 | #790                                                                                  |
| [#1763](https://github.com/Emanuele-web04/synara/pull/1763) | `08d3f4b42a6900e168b3c33bc639c49a45a5a049` | Superseded candidate by #1891 | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1765](https://github.com/Emanuele-web04/synara/pull/1765) | `9372e0f92592eb178844fb8d7920066b41eb7677` | Issue-driven candidate        | #1701                                                                                 |
| [#1766](https://github.com/Emanuele-web04/synara/pull/1766) | `9a3d11f1c9e5383997e46dcc67fc200bf25d571c` | Superseded candidate by #1892 | #1729                                                                                 |
| [#1767](https://github.com/Emanuele-web04/synara/pull/1767) | `a229ade582f84a1b1c66a1aef97592de5ff1f826` | Superseded candidate by #1893 | #1330, #1620                                                                          |
| [#1768](https://github.com/Emanuele-web04/synara/pull/1768) | `681712401fbfe3d9f80d1f15e89e226bca2255f4` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1769](https://github.com/Emanuele-web04/synara/pull/1769) | `bb0a3bf275d50486dcccee4edde4b355db003f80` | Issue-driven candidate        | #1268                                                                                 |
| [#1770](https://github.com/Emanuele-web04/synara/pull/1770) | `bdda83e868caf7305bc87d0a13246211bd70623e` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1771](https://github.com/Emanuele-web04/synara/pull/1771) | `6933479a0a8e71ca9026d077135d318c985ba927` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1772](https://github.com/Emanuele-web04/synara/pull/1772) | `6439bc057561e6af65ab1ce36e6a24bdd27218cc` | Superseded candidate by #1894 | Automatic title generation regression (#1223 lineage).                                |
| [#1779](https://github.com/Emanuele-web04/synara/pull/1779) | `43724b4a453994553b092d5fe266081b41036c74` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1780](https://github.com/Emanuele-web04/synara/pull/1780) | `6a49990ce147210acd44ec4ceb4625d7244df3ac` | Superseded candidate by #1895 | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1783](https://github.com/Emanuele-web04/synara/pull/1783) | `388a896e78137a70c88bbc5718b1f9b05ddd93c7` | Issue-driven candidate        | #787                                                                                  |
| [#1784](https://github.com/Emanuele-web04/synara/pull/1784) | `5ff94109cd95362043f4f23596d78e0c861c0749` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1785](https://github.com/Emanuele-web04/synara/pull/1785) | `6caf40fbc824df93a7c0cf102857e426e2b0b435` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1786](https://github.com/Emanuele-web04/synara/pull/1786) | `39c05e66934c1b1bc57ca0493d191b784456a679` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1787](https://github.com/Emanuele-web04/synara/pull/1787) | `e48fdc252e17e7787baeb511eb08e1f0a7d96af7` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1788](https://github.com/Emanuele-web04/synara/pull/1788) | `546e444d27301946165569e5daeed7af98e8bbff` | Issue-driven candidate        | #1703                                                                                 |
| [#1789](https://github.com/Emanuele-web04/synara/pull/1789) | `495c5f8b3c9af27e2bacd15df51f02326f165498` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1792](https://github.com/Emanuele-web04/synara/pull/1792) | `de6bfe4892d0178f4eecb33c95696dcfe583836e` | Issue-driven candidate        | #1709                                                                                 |
| [#1793](https://github.com/Emanuele-web04/synara/pull/1793) | `f6ac5c344859aeb5defe9dc10fa1b4dd51d84b07` | Issue-driven candidate        | #1710                                                                                 |
| [#1795](https://github.com/Emanuele-web04/synara/pull/1795) | `a6cf2fc4167640d7f3d762d7244c04b0d70e811e` | Issue-driven candidate        | #864, #1148                                                                           |
| [#1797](https://github.com/Emanuele-web04/synara/pull/1797) | `9bd56665c4be59d80b2ebb9e73c64201593a4165` | Issue-driven candidate        | #1160                                                                                 |
| [#1803](https://github.com/Emanuele-web04/synara/pull/1803) | `6d0b84efda1b9258ef6c69e0210c1324c88253a0` | Issue-driven candidate        | #1206                                                                                 |
| [#1804](https://github.com/Emanuele-web04/synara/pull/1804) | `676fd914c06bfdca3fcbd2a90a4847c7c856e718` | Issue-driven candidate        | #1158                                                                                 |
| [#1807](https://github.com/Emanuele-web04/synara/pull/1807) | `44c8c8e93896af9d9e8d0fe91591bd6c55be61a1` | Issue-driven candidate        | #421                                                                                  |
| [#1812](https://github.com/Emanuele-web04/synara/pull/1812) | `9606c2ba4bb514a2d92a863768303fb35399a452` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1818](https://github.com/Emanuele-web04/synara/pull/1818) | `05468139342aec85015f85eab000bde8bbe805dd` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1821](https://github.com/Emanuele-web04/synara/pull/1821) | `ab8a77a873e2443ffc9a9570cbd2919219fd41c9` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1823](https://github.com/Emanuele-web04/synara/pull/1823) | `18ac1fbeb001eb5b3578533beac57834d7cce81b` | Issue-driven candidate        | #1367                                                                                 |
| [#1824](https://github.com/Emanuele-web04/synara/pull/1824) | `e47ba2e1109b5f1ad7560f89e8176b4f018ac3a9` | Issue-driven candidate        | #174                                                                                  |
| [#1826](https://github.com/Emanuele-web04/synara/pull/1826) | `e018d5fa930ab13a2703587a828bd3c64f3c9b5c` | Issue-driven candidate        | #175                                                                                  |
| [#1827](https://github.com/Emanuele-web04/synara/pull/1827) | `cd63cea4dec2b51cc79be8c5480956696cf82b23` | Issue-driven candidate        | #892                                                                                  |
| [#1831](https://github.com/Emanuele-web04/synara/pull/1831) | `ac0e7f65b6860dbc4e7c308acbc01a886238f559` | Issue-driven candidate        | #1504                                                                                 |
| [#1832](https://github.com/Emanuele-web04/synara/pull/1832) | `101a3c9653f2feeab0c7bf3dbcbe163bf01d6869` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1835](https://github.com/Emanuele-web04/synara/pull/1835) | `9fb04ac2735b42efbdfd615efec723673395bab0` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1836](https://github.com/Emanuele-web04/synara/pull/1836) | `8f68d9fbcef7716887af8437337ff1b5bab69984` | Issue-driven candidate        | #1198                                                                                 |
| [#1839](https://github.com/Emanuele-web04/synara/pull/1839) | `fc3cd0c5e744041108b5d9109730cba1ded9c4ee` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1840](https://github.com/Emanuele-web04/synara/pull/1840) | `600a2da636e4c191bebaeade3f5751f0665b39ed` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1841](https://github.com/Emanuele-web04/synara/pull/1841) | `a3098848972482e13d772bd7581a6c1203650586` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1845](https://github.com/Emanuele-web04/synara/pull/1845) | `99a1c00c46db38e557a29cb6c958692b0558d297` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1847](https://github.com/Emanuele-web04/synara/pull/1847) | `ffadf6493586b87cf41d1ae5484e2342f96373f6` | Issue-driven candidate        | #1837                                                                                 |
| [#1848](https://github.com/Emanuele-web04/synara/pull/1848) | `879dc7b2c727d781995a012c509bccd2cf7af505` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1851](https://github.com/Emanuele-web04/synara/pull/1851) | `7f1c5b1f658033e1d1016eab4be49b7444500cd6` | Issue-driven candidate        | #1283                                                                                 |
| [#1854](https://github.com/Emanuele-web04/synara/pull/1854) | `4f7c61fe6f028d69ef187c9437286e7830628da4` | Issue-driven candidate        | #1849                                                                                 |
| [#1856](https://github.com/Emanuele-web04/synara/pull/1856) | `be4186e34d1e0437ee9b3c671a9fb3652ab599de` | Issue-driven candidate        | #1830                                                                                 |
| [#1857](https://github.com/Emanuele-web04/synara/pull/1857) | `00d069ea71154ae11b87944a542bb845878b7050` | Issue-driven candidate        | #1069                                                                                 |
| [#1858](https://github.com/Emanuele-web04/synara/pull/1858) | `dda2c1a8fab592a062c167b4a76e973ac633ab16` | Issue-driven candidate        | #1220                                                                                 |
| [#1860](https://github.com/Emanuele-web04/synara/pull/1860) | `638e419bc952566932bbf7cddf0b129bafc4d434` | Issue-driven candidate        | Defect or requested behavior described in PR; confirm origin before inclusion.        |
| [#1870](https://github.com/Emanuele-web04/synara/pull/1870) | `d25d4238f516e1400346878f4d071b6bb88c1b0e` | Issue-driven candidate        | #1863                                                                                 |
| [#1889](https://github.com/Emanuele-web04/synara/pull/1889) | `090f6157d33de5f6576765d58a5e7119b0280972` | Repair continuation           | #1745                                                                                 |
| [#1890](https://github.com/Emanuele-web04/synara/pull/1890) | `16a294241614f6e2770bfd3be4681ecf9a189f0b` | Repair continuation           | #1757                                                                                 |
| [#1891](https://github.com/Emanuele-web04/synara/pull/1891) | `623d5b94f104c2680fd62550739371b573765b28` | Repair continuation           | #1763                                                                                 |
| [#1892](https://github.com/Emanuele-web04/synara/pull/1892) | `d3345bd0916e9659978c071650c0aa30a7270e25` | Repair continuation           | #1766                                                                                 |
| [#1893](https://github.com/Emanuele-web04/synara/pull/1893) | `e8e1d62c518118deb51c5ea145a28fa53b9faa74` | Repair continuation           | #1767                                                                                 |
| [#1894](https://github.com/Emanuele-web04/synara/pull/1894) | `ed2ce514f2f61a4a3e5c9c6ec055c505b6c344f2` | Repair continuation           | #1772                                                                                 |
| [#1895](https://github.com/Emanuele-web04/synara/pull/1895) | `13b7ceb34999a7133f0bea6e832390da19b7113f` | Repair continuation           | #1780                                                                                 |
| [#1914](https://github.com/Emanuele-web04/synara/pull/1914) | `68d92155d96ca6cce87704c32bc2a3353a9cd4ce` | Issue-driven candidate        | Chat navigation regression; source issue link absent—review behavior.                 |
| [#1916](https://github.com/Emanuele-web04/synara/pull/1916) | `1524206aa96ea1235634b0948c573027f68147c0` | Issue-driven candidate        | Continuation of #1911; split unrelated on-demand playbooks if not required.           |
| [#1938](https://github.com/Emanuele-web04/synara/pull/1938) | `76674c7925d79a2ce0f5da126ffe5b1966c69701` | Issue-driven candidate        | Browser login/session regression; possible passkey scope expansion—review separately. |
| [#1944](https://github.com/Emanuele-web04/synara/pull/1944) | `049b6fe05e93748352587ac0299553653de8f8c5` | Issue-driven candidate        | #1943: PR size and labels automation.                                                 |

## Reconstruction order

1. Rebase the **candidate integration tree**, not the original PRs, on a refreshed `main`. Exclude standalone functionality and already-merged work. Do not force-push or rewrite others' branches.
2. Reconcile overlapping repair chains, migrations, shared UI state, browser/runtime lifecycles, and packaging. Check that required behavior survives each resolution.
3. Run targeted cross-feature acceptance (provider/runtime recovery, browser handoff, sidebar, persistence, Linux packaging, migration lineage), necessary static checks, and current-head CI. Record screenshots for actual visual changes.
4. Review full diff for omissions, standalone features, generated churn, secrets, or unintended branch imports. Keep #1878 **draft** and leave all `main` merges to the maintainer.

See [the original combined integration report](all-my-prs-20261012.md) for historic proof and explicitly unresolved gaps, and [issue #1646](https://github.com/Emanuele-web04/synara/issues/1646) for the repository-wide repair tracker.
