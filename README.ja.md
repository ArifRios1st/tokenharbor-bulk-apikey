<div align="center">

```
████████╗ ██████╗ ██╗  ██╗███████╗███╗   ██╗██╗  ██╗ █████╗ ██████╗ ██████╗  ██████╗ ██████╗
╚══██╔══╝██╔═══██╗██║ ██╔╝██╔════╝████╗  ██║██║  ██║██╔══██╗██╔══██╗██╔══██╗██╔═══██╗██╔══██╗
   ██║   ██║   ██║█████╔╝ █████╗  ██╔██╗ ██║███████║███████║██████╔╝██████╔╝██║   ██║██████╔╝
   ██║   ██║   ██║██╔═██╗ ██╔══╝  ██║╚██╗██║██╔══██║██╔══██║██╔══██╗██╔══██╗██║   ██║██╔══██╗
   ██║   ╚██████╔╝██║  ██╗███████╗██║ ╚████║██║  ██║██║  ██║██║  ██║██║  ██║╚██████╔╝██║  ██║
   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝
```

# tokenharbor-bulk-apikey

**自動生成された API キーで Token Harbor アカウントを一括作成 — OpenAI 互換の推論 (DeepSeek V4.1 Flash、DeepSeek V4 Flash、MiMo V2.5、MiMo V2.6 Flash) + 9Router / OmniRoute コネクタ。**

[![Node](https://img.shields.io/badge/Node-%E2%89%A518-3DA639?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-1%20(browser%20only)-blue?style=for-the-badge)](#)
[![License](https://img.shields.io/badge/license-MIT-6ea8fe?style=for-the-badge)](LICENSE)
[![Models](https://img.shields.io/badge/free%20models-4-412991?style=for-the-badge)](https://tokenharbor.ai/pricing)
[![9Router](https://img.shields.io/badge/9Router-connector-8B5CF6?style=for-the-badge)](#-connect-to-9router)
[![OmniRoute](https://img.shields.io/badge/OmniRoute-connector-8B5CF6?style=for-the-badge)](#-connect-to-omniroute)

[🛠 クイックスタート](#-quick-start) · [🎁 無料枠](#-free-tier--how-much-you-get) · [🤖 モデル](#-models--all-4-of-them) · [🧪 API の使い方](#-how-to-use-the-api) · [✅ 検証済み](#-verified-working--every-key-is-tested) · [🧭 仕組み](#-how-it-works) · [🔌 9Router](#-connect-to-9router) · [🔌 OmniRoute](#-connect-to-omniroute) · [⚙️ オプション](#️-cli-options) · [🛰️ プロキシ](#️-behind-a-proxy) · [🐞 問題報告](#-issues)

</div>

<div align="center">

**English** · [Türkçe](README.tr.md) · [中文](README.cn.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [Português](README.pt.md)

</div>

---

## ✨ これが存在する理由

Token Harbor は Next.js のパネル (Supabase 認証) で、無料枠は**パーセンテージベース**です。個人の
**7 日間ウィンドウ**が最初の無料リクエストから始まり、固定のリクエスト数ではなく定価の一定割合を
消費します。サインアップはメール + パスワードで、**Cloudflare Turnstile ウィジェット**とネットワーク
ごとの制限があります — 1 ネットワーク = 1 アカウントなので、一括実行は実質的に「アカウントごとに
1 つの新しい出口」です。

サインアップ後には 2 つのゲートがあり、どちらも見落としがちです。サインアップメールのリンクを
開くまで API は `403 email_verification_required` を返し、無料モデルの同意を有効にするまで
すべての `:free` ルートは `403 free_models_disabled` を返します — しかもその同意エンドポイントは
**クライアントが表示したテキストを検証する** (`shown_text`) ため、素の
`{"free_models_enabled":true}` は `400 reload_and_retry` を返します。この CLI はそのすべてを
行い、実行のたびにライブページから Next.js のアクション ID と同意テキストを読み取り、ライブの
chat-200 を通過したキーだけを書き込みます。

## 🎁 無料枠 — どれだけ使えるか

| 項目 | 値 |
| --- | --- |
| 無料モデル | **4** — DeepSeek V4.1 Flash、DeepSeek V4 Flash、MiMo V2.5、MiMo V2.6 Flash (`:free` サフィックス) |
| 割当量 | **定価に対するパーセンテージ**、固定のリクエスト数ではない (実測: 約 25 回呼び出し後も `0%`) |
| ウィンドウ | **個人の 7 日間**、最初の無料リクエストから開始 (`x-th-free-resets` ヘッダー) |
| アカウントのレート制限 | **60 req/min**、**1,800 req/h** |
| IP レート制限 | **100 req/min**、**3,000 req/h** (レート超過時は `429`、または `error` ボディ付きの HTTP `200` を返し、待機時間を通知) |
| 同時実行数 | 上限なし |
| 有料モデル | 70+ (Claude、Grok、GLM、MiMo Pro …) — クレジットが必要。残高ゼロのアカウントは `402` を返す |
| カード必須 | **いいえ** |
| 電話番号必須 | **いいえ** |
| キャプチャ | サインアップ時に **Cloudflare Turnstile** — `src/solver.js` が同じ出口経由でオフスクリーンの Chrome 内で本物のトークンを生成 |
| メール認証 | **必須** — CLI がリンクを開き、`307` をたどって `?verify=success` に到達 |
| スケールする単位 | **1 アカウント = 1 キー** → `--count N` は実質的に「N ネットワークから N アカウント」 |

記録しておく価値のあるヘッダー: `x-th-plan`、`x-th-free-used-pct`、`x-th-free-resets`、
`x-th-upstream-model`、`x-th-route-decision`。

## 🤖 モデル — 全 4 種類

| モデル ID | 備考 |
| --- | --- |
| `deepseek-v4.1-flash:free` | デフォルト。約 9〜11 秒で PONG を返す |
| `deepseek-v4-flash:free` | CLI がライブゲートでも試すフォールバックモデル |
| `mimo-v2.5:free` | MiMo ファミリー |
| `mimo-v2.6-flash:free` | 4 つの中で最速 |

エンドポイントは合計 **78 個のモデル ID** を提供します (有効なキーで `GET /v1/models`)。上記の
4 つはクレジットなしで動作するものです。ツール/関数呼び出しは無料ルートでも動作します:
`get_time` スキーマは実際の `tool_calls` 配列として返ってきます。

## 🧪 API の使い方

```bash
curl https://tokenharbor.ai/v1/chat/completions \
  -H "Authorization: Bearer $TOKENHARBOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash:free","messages":[{"role":"user","content":"hi"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="https://tokenharbor.ai/v1", api_key="YOUR_KEY")
print(client.chat.completions.create(
    model="deepseek-v4.1-flash:free",
    messages=[{"role": "user", "content": "hi"}],
).choices[0].message.content)
```

## 🚀 コマンド 1 つ

```bash
npm start            # メニュー → 「Mint keys」 → 個数 → 完了
```

`npm start` はランチャーを開き、**1) Mint keys** は個数を尋ねるだけで、あとは CLI がキーごとに
1 アカウントを作成し、それぞれをライブのチャット呼び出しで検証して、生き残ったものを
`keys.txt` に書き込みます。

## 🛠 クイックスタート

```bash
git clone https://github.com/F0Rextasy/tokenharbor-bulk-apikey.git
cd tokenharbor-bulk-apikey
npm install
echo "YOUR_MAILTRAP_TOKEN" > mailtrap.txt   # 必須 — 下記の警告を参照
npm start            # メニュー → 1) Mint keys → 個数 → 完了
```

> **`mailtrap.txt` がないとミントは一切動作しません。** Token Harbor はすべての公開メールボックス
> ドメインを拒否するため、認証リンクを読めるものがなく、すべてのアカウントが
> `403 email_verification_required` で停止します。フォールバックはありません。まず無料トークンを
> 取得してください。

**Mailtrap トークンが唯一のセットアップ手順です。** Token Harbor は本物の受信メールホストのように
見えるメールドメインを受け付け、公開の使い捨てドメインには「complete the human check」と返します
(それらについてはウィジェットすら描画しません)。そのため CLI には読み取り可能なメールボックスが
必要です。無料枠で十分です: [mailtrap.io](https://mailtrap.io) でアカウントを作成し →
**Settings → API Tokens** を開き、その値を `package.json` の隣にある `mailtrap.txt` に書き込みます
(1 行)、または `MAILTRAP_TOKEN` をエクスポートします。ランチャーはそれを確認し、欠けていれば
通知します — 値そのものを尋ねることはありません。

トークンがない場合、CLI はまず公開のメール経路を試しますが、すべてのアカウントがパネルの
human-check の壁で停止します — だからこそこのファイルは任意ではなく必須なのです。

## ✅ 動作検証済み — すべてのキーがテストされます

キーが `keys.txt` に書き込まれるのは、ミント時に以下を通過した場合のみです:

- `:free` モデルでのライブ `chat-200`、および
- **2 つの異なるプロンプト**が、空でなく**異なる**内容で 200 を返すこと。

エンドツーエンドの実測 (`node src/cli.js --auto --count 1 --pool proxies.txt`):

```
[1/1] mailbox th-…@inbound-mailtrap.io (mailtrap)
   precheck 200 · human check no
   signup 200 · session ok
   activity /dashboard 200
   consent text live (1464 chars)
   consent 200
   verify 307 https://tokenharbor.ai/dashboard?verify=success
   activity /dashboard 200
   activity /dashboard/api-keys 200
   key 201
   activity /dashboard/api-keys 200
   free-tier unlocked=false activated=false exhausted=false rpm_limit=1000000 req_used=0 used_pct=0
   account saved to accounts.txt
  ✔ thk_live_… saved to keys.txt (1/1)
done
```

いつでも `npm start` → **2) Verify keys** (`node src/cli.js --verify`) で再確認できます。死んだ
キーは `keys-dead.txt` に移動し、ライブゲートを完了できなかったキー (例: ネットワークがレート
制限に達した) は `keys-unverified.txt` に入るので、アカウントが失われることはありません。

## 🧭 仕組み

1. **メールボックス** — アカウントごとにあなたの Mailtrap アカウント上で新しい受信箱を作成
   (`mailtrap.txt`)。公開の mail.tm / mail.gw はフォールバック経路です。
2. **サインアップ** — Next.js のサーバーアクション ID (`next-action`、`$ACTION_KEY`、
   `x-deployment-id`) は実行のたびにライブページから読み取られるため、パネルの再デプロイで CLI が
   壊れることはありません。デバイスフィンガープリント、タイムゾーン、年齢確認はリクエストに付随し、
   タイムゾーンはあなたのマシンではなく出口から測定されます。Cloudflare がログインページに
   エッジチャレンジ (`Just a moment...`、VPN/データセンターの出口でよく見られる) を返した場合、
   ミントの残りは同じ出口上の実際の Chrome 内で実行されます。すべてのリクエスト (discover、
   signup、consent、verify、keys、ライブゲート) がブラウザ自身の fetch を通ります。クリアランス
   Cookie だけでは不十分だからです — `cf_clearance` は解決したブラウザの TLS フィンガープリントに
   紐付けられており、有効な Cookie が jar にあっても Node のリクエストはチャレンジされたままに
   なります。ユーザー名付きの SOCKS 出口では、Chrome は SOCKS を直接話すのではなく、localhost の
   転送プロキシ (`src/local-proxy.js`) を経由します。Chrome の SOCKS5 認証処理がハングするためです。
3. **human check** — パネルがウィジェットを描画した場合、サインアップは実際のブラウザで
   リプレイされます (`src/solver.js`、`puppeteer-core` + 既にインストール済みの Chrome または
   Brave、あるいは `BRAVE_PATH` / `CHROME_PATH` に指定したパス。`--enable-automation` は意図的に
   抑制されます)。チェックボックスはマウスでクリックされ、そのブラウザのセッション Cookie が CLI に
   引き渡されます。
4. **無料モデルの同意** — ダッシュボードからライブで読み取った同意テキストを伴って
   `POST /api/me/privacy` を送信します。ダッシュボードの JS チャンク内の同意文に
   `GET /api/me/free-tier` からのモデル一覧を加え、ブラウザのモーダルの `innerText` とまったく
   同じ形に組み立てます (`src/consent-text.txt` はライブ読み取りに失敗した場合のフォールバックに
   過ぎません)。`screen: "consent_modal"`、`path: "/dashboard"`。これはブラウザと同じように、
   メール認証の前に実行されます。サインアップ直後、CLI はダッシュボードのページビュービーコン
   (`POST /api/auth/activity?page=%2Fdashboard`) も送信します。
5. **メール認証** — メールボックスからのリンクが開かれます。トークンはサーバー側で消費され、
   `307 → /dashboard?verify=success` を返します。ダッシュボードのビーコンは、ブラウザと同じように、
   認証後のランディング後に再び発火します。
6. **キー + ライブゲート** — `POST /api/keys` の前後にアクティビティビーコン
   (`POST /api/auth/activity?page=%2Fdashboard%2Fapi-keys`) を送ります。アカウントのログイン情報
   (`email:password`) はキーが存在する時点ですぐに `accounts.txt` に保存されるため、ライブゲートが
   失敗してもアカウントをブラウザで手動で開けます。その後、無料枠を 1 回読み取り
   (`GET /api/me/free-tier`)、1 行でログに記録します。これにより、ゲートが実行される前に
   ミント済みアカウントのレート制限状態が見えます。その後、2 つの異なるプロンプトが両方とも
   異なる内容で 200 を返さなければキーは書き込まれません。

## ⚙️ CLI オプション

```bash
node src/cli.js --auto --count 5             # 5 アカウント → 5 キー
node src/cli.js --auto --count 5 --pool proxies.txt
node src/cli.js --verify                     # keys.txt をライブチェック、死んだもの → keys-dead.txt
node src/cli.js --screen --pool proxies.txt  # どの出口がパネルに到達できるか
node src/cli.js --models                     # 無料モデル一覧 (キーが必要)
node src/cli.js --help
```

| フラグ | 意味 |
| --- | --- |
| `--count <n>` | 作成するアカウント (およびキー) の数、デフォルト 1 |
| `--pool <file>` | プロキシリスト、1 行に 1 出口 (`http://host:port`、`socks5://user:pass@host:port`、`host:port`)。インラインの `#` コメントも可 |
| `--headless` | フォールバックブラウザをヘッドレスで実行 (デフォルト: オフスクリーンウィンドウ。キャプチャはこれを期待) |
| `--verbose` | ローカルプロキシの接続ごとのログ (`+conn` / `upstream ok` / `-conn`) を表示する。これがないと結果の行のみが表示される |
| `--screen` | プールをパネルに対してテストし、出口ごとに live / challenged (cloudflare) / dead を表示。チャレンジされた出口でもミントは可能で、その場合は Chrome 内でミントが実行される |
| `--verify` | `keys.txt` をライブ検証。死んだキーは `keys-dead.txt` に書き込まれる |
| `--models` | 無料モデル ID を表示 |
| `--strict-proxy` | 直接リクエストを一切送らない: ライブゲートもプール経由でなければならない (環境変数 `TOKENHARBOR_STRICT=1` も同じ) |

死にかけた出口がアカウントを失わせることはありません: サインアップとライブゲートはどちらも
プールの他の行でリトライし、レート制限 (`429`、またはボディに `rate_limit_exceeded` を含む
`200`) はパネルが指定する時間だけ待機します。ゲートはパネルのレート制限メッセージを待機時間
とともにログに記録するため、そこに示されるスコープ (per-IP、per-key、per-account) がログに現れ、
単なる「rate limited」にはなりません。

ブラウザの事前解決が遅い場合、何かをチューニングする前に、それが出口の問題なのかコードの
問題なのかを確認してください:

```bash
node scripts/diag-browser-proxy.js --pool proxies.txt [--exit 0]
```

実際のプール行 (CLI とまったく同じように解析される) を読み取り、そのプロキシ経由の生の fetch を
段階ごとに計測し、次に同じ出口経由のブラウザ (ホスト名、解決済み IPv4、`--disable-http2`)、
そしてブラウザ直接を計測して、遅い部分を特定する判定を表示します。プール行内の認証情報は
使用されますが、決して表示されません。

ミントがライブゲートに到達したのにチャット呼び出しがタイムアウトする場合、保存済みのキーを
直接テストしてください — キー自体が生きているかどうかも分かります:

```bash
node scripts/diag-chat-gate.js --pool proxies.txt [--exit 0] [--timeout 300]
```

ミントと同じブラウザクライアントを開き、ゲートとまったく同じプロンプトで
`/v1/chat/completions` を呼び出し、レスポンスボディをストリーミングします。ヘッダーが届いた
タイミング、各チャンクが届いたタイミング、ストリームが終了したかどうかを記録するため、遅い
モデル、少しずつ流れるストリーム、停止したエンドポイントが見分けられます。キーは
`keys-unverified.txt` (フォールバック `keys.txt`) から読み取られ、決して表示されません。

## 🛰️ プロキシ経由

CLI はデフォルトで**直接**実行されます。`proxies.txt` に 1 行に 1 出口を書く (ランチャーが
自動的に読み取ります) か、`--pool` を渡します:

```text
http://127.0.0.1:8080
socks5://user:pass@10.0.0.5:1080
10.0.0.5:8080
```

任意 — 大規模実行では推奨: パネルはサインアップを**ネットワークごと**に制限するため、
アカウントごとに 1 つの新しい出口を使うと大規模な実行が健全に保たれます。メールはあなたの
Mailtrap アカウントから直接読まれる (メールプロバイダはパネルではない) ため、遅い出口が
メールボックスのステップを壊すことはありません。

## 📄 ファイル

| パス | 内容 |
| --- | --- |
| `keys.txt` | 検証済みキー、1 行に 1 つ (ライブゲート通過後にのみ書き込み) |
| `keys-dead.txt` | 応答しなくなったキー (`--verify` から) |
| `keys-unverified.txt` | ライブゲートを完了できなかったキー — アカウントは存在し、キーは本物 |
| `accounts.jsonl` | アカウントごとに 1 行: メール + ステップ結果 |
| `accounts.txt` | アカウントのログイン情報 (`email:password`)、アカウントごとに 1 行 — ブラウザでの手動ログイン用 |
| `mailtrap.txt` | あなたの Mailtrap API トークン (1 行) |
| `proxies.txt` | 任意のプロキシリスト |
| `src/cli.js` | ミント / 検証 / スクリーニングの CLI |
| `src/launcher.js` | メニュー (`npm start`) |
| `src/solver.js` | Turnstile ウィジェット用のブラウザ側部分 |
| `src/consent-text.txt` | フォールバックの同意テキスト (ダッシュボードからのライブ読み取りがまず試される) |
| `src/connect-9router.js`、`src/connect-omniroute.js` | ルーターコネクタ |

## 🔌 9Router に接続

```bash
node src/connect-9router.js --base http://localhost:20128 --password 123456
```

1 つの `openai-compatible` プロバイダノード (`tokenharbor`、ベース URL
`https://tokenharbor.ai/v1`) と、`keys.txt` 内のキーごとに 1 つの接続を登録するので、9Router が
あなたのキー間で負荷分散します。冪等: 既存のノードや接続は再利用され、番号は既に存在する
最大の `tokenharbor-0NN` から続きます。

## 🔌 OmniRoute に接続

```bash
node src/connect-omniroute.js --base http://localhost:20128 --password 123456
```

OmniRoute も同じ形です (プロバイダノード + キーごとに 1 接続)。ランチャーは両方をメニュー項目
**6** と **7** として公開しており、`npm run 9router` / `npm run omniroute` も同じことを行います。

## 🔑 1 つのキーで得られるもの

- 上記の 4 つの `:free` モデルを、アカウントあたり 60 req/min および 1,800 req/h で (IP あたり
  100 req/min)。
- 個人の 7 日間ウィンドウ内でのパーセンテージベースの割当量 (`x-th-free-resets` がロールオーバー
  時期を通知)。
- ツール呼び出し対応の OpenAI 互換 `/v1/chat/completions`。`base_url` を
  `https://tokenharbor.ai/v1` に変えるだけで、あらゆる OpenAI SDK、CLI、ルーターが動作します。
- 有料モデルはアカウントにクレジットがあるまでロックされたまま (それ以外は `402`)。

## 🐞 問題報告

コマンド、失敗したステップ (CLI は `precheck / signup / verify / consent / key / chat` を表示)、
およびパネル自身のメッセージを添えて issue を開いてください。完全な API キーは決して貼り付け
ないでください — 最後の 4 文字で十分です。

## 📄 ライセンス

MIT — [LICENSE](LICENSE) を参照。このツールは Token Harbor とは提携していません。所有する
アカウントにのみ使用し、パネルの利用規約を尊重してください。