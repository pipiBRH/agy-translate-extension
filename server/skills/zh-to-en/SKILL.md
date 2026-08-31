---
name: zh-to-en
description: 把中文翻成英文，並附上三個語氣不同的替代說法讓使用者自己挑場合。只要使用者貼了中文、想要英文產出就用這個 skill——包含「翻成英文」「這句英文怎麼說」「幫我用英文寫」「英文版」，以及把中文的 email、Slack/Teams 訊息、PR 描述、Confluence 文件、公告、簡報改寫成英文。使用者沒說「翻譯」兩個字但意圖是要英文輸出時同樣要用，例如「我想跟外國同事講 X，怎麼開口」「這段跟老闆報告要怎麼寫成英文」。若輸入本身已經是英文、只是要改得更好，那是 polish-english 的範圍，不是這個 skill。
---

# 中翻英

## 這個 skill 在解決什麼問題

翻譯本身不難，難的是**選對語氣**。中文一句「幫我看一下」，對熟同事、對客戶、對 VP 的英文講法完全不同，但你在翻譯的當下不知道收件人是誰、他們關係多熟、這封信會不會被轉發出去。使用者知道，你不知道。

所以正確的做法不是猜一個語氣賭對，而是：**給一個中性穩妥的主翻譯，再給三個在語氣光譜上真正分開的替代句，讓使用者用他手上的人際脈絡自己挑。** 使用者花三秒鐘掃過去就能決定，比你猜錯讓他重問一次快得多。

## 輸出格式

一律用這個結構，不要加前言、不要解釋你怎麼翻的：

```
**翻譯**
<主翻譯>

**其他說法**
1. <替代句 A> — <場合標註>
2. <替代句 B> — <場合標註>
3. <替代句 C> — <場合標註>
```

場合標註一律**用英文寫**，而且開頭必須是 `casual` / `neutral` / `formal` / `concise` 其中一個詞，後面接破折號與具體對象，例如 `casual — close teammates`。開頭這個詞是給下游工具判讀語氣用的，順序固定才不會被誤判；後半的具體對象才是給人看的決策依據。

翻譯完就停。除非使用者問，否則不要附上逐字對照、不要解釋文法、不要說「希望這對你有幫助」。

## 主翻譯怎麼挑

主翻譯要選**放到任何場合都不會出事**的版本：語氣中性偏客氣、句子結構單純、用字是母語者日常真的會用的。

判斷標準是「這句話貼到公司群組會不會有人覺得怪」。太口語（Mind giving this a look?）貼給客戶會顯得隨便；太正式（Kindly be advised that...）貼給同事會像法務信。中間那格才是主翻譯。

如果上下文已經講明場合了——使用者說「這是要給 VP 的」「這是回客戶的信」「我要在群組裡講」——那就直接照那個場合的語氣當主翻譯，不要還給中性版本。

## 三個替代說法怎麼挑

**最容易做壞的地方是把它做成同義詞替換。** 把 help 換成 assist、把 check 換成 verify，這種東西使用者自己就會，給了等於沒給。

三個替代句要在真正會影響溝通結果的維度上分開：

- **正式度**：口語 ↔ 商務中性 ↔ 正式書面
- **直接程度**：委婉暗示 ↔ 平鋪直述 ↔ 明確要求
- **句型結構**：問句（Could you...）／陳述句（I'd appreciate...）／祈使句（Please...）

好的三個替代句應該讓人一看就知道「喔這三個是給不同人看的」，而不是「這三個好像差不多」。

場合標註的後半要寫**具體的人際關係或用途**，不要只重複那個語氣詞。`casual — close teammates` 比 `casual — informal` 有用得多，因為使用者要的是決策依據，不是同義詞。同理 `formal — external partners or management` 比 `formal — polite` 有用。整段標註控制在六、七個字以內，那是一列窄卡片能放下的長度。

## 常見的中式英文陷阱

這些是中文母語者最常直譯出錯的地方，翻譯時特別留意：

| 中文 | 別直譯成 | 通常該用 |
|---|---|---|
| 配合 | cooperate with | work with / align with / accommodate |
| 跟你反饋一下 | give you feedback | let you know / flag / update you |
| 跟進 | follow | follow up on |
| 溝通一下 | communicate | talk to / sync with / discuss |
| 幫我確認一下 | confirm | double-check / verify |
| 麻煩你 | trouble you | could you / would you mind |
| 請問 | May I ask | 直接問，不用鋪陳 |
| 進行測試／進行檢查 | conduct a test | test / check（直接用動詞） |
| 我這邊／你那邊 | my side / your side | on my end / on your end，多數時候整個省略 |
| 辛苦了 | you worked hard | 看場合：thanks for pushing this through / 或直接省略 |

還有幾個結構性的問題：

- **「先...一下」的「先」**：中文愛用，英文常常沒有對應詞，硬加 first 會很怪。
- **「因為...所以...」**：英文只留一個連接詞，兩個都放是文法錯誤。
- **please 用太多**：每句都 please 反而像機器人，或變成客氣的命令。一段話裡一次就夠。
- **主語省略**：中文常省略主語，英文一定要補回來，補錯人會出事（是我做還是你做）。
- **中文的長句**：一句中文塞三個子句，翻成英文要考慮斷句，一路 which / that 接下去讀起來很累。

## 特殊情況怎麼處理

**長文（超過三、四句或多段落）**：全文給三個版本沒有意義，也沒人會讀。改成先給完整翻譯，再挑出其中**最難翻或最關鍵的兩三句**給替代說法，並說明是針對哪一句。使用者真正在意的通常就是那幾句。

**技術文件、PR 描述、commit message**：這類文字的價值在精準不在漂亮。主翻譯要簡潔直接，替代說法的維度換成「詳盡程度」和「技術術語濃度」，而不是禮貌程度。技術名詞（deploy、rollback、endpoint、token）維持原文，不要翻。

**專有名詞和內部術語**：公司名、產品名、系統名、人名維持原文。不確定是不是專有名詞就維持原文，翻錯比不翻更糟。

**輸入包含明顯錯字或語意不清**：照你最合理的理解翻，翻完在最後補一行短短的確認，例如「（假設『這個』指的是 PR 而不是 ticket）」。不要停下來問，那會打斷使用者的節奏。

## 範例

**輸入**：麻煩你在我 merge 之前幫我看一下

```
**翻譯**
Could you help me double-check this before I merge it?

**其他說法**
1. Mind giving this a quick look before I merge? — casual — close teammates
2. I'd appreciate a second pair of eyes on this before merging. — neutral — cross-team or less familiar
3. Please review this prior to the merge. — formal — external or management
```

**輸入**：這個問題我們排查了很久，發現是上游服務的超時設定有問題，已經改好了

```
**翻譯**
We spent a while tracking this down — it turned out to be a timeout misconfiguration on the upstream service. It's fixed now.

**其他說法**
1. Took us a while to find, but it was just a bad timeout setting upstream. Fixed. — casual — same-team sync
2. After extensive investigation, we identified the root cause as an incorrect timeout configuration in the upstream service. The fix has been applied. — formal — incident report
3. Root cause: incorrect timeout setting on the upstream service. Fix deployed. — concise — ticket or PR description
```
