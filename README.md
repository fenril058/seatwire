# seatwire

Claude Code と Codex CLI の間でメッセージを交換する、Linux / WSL 向け CLI です。
暫定名は seatwire です。
Node.js 24 の組み込み SQLite を使い、実行コードと永続データを分離します。

現状は初期実装です。
送受信・既読・並行アクセス・通知 I/O・tmux 操作・Home Manager の撤去を自動テストしています。
WSL2 上で通常起動した Claude Code と Codex CLI が相手を発見し、通知で依頼と返信を往復させ、双方で既読にするところまで確認しました。
Codex のサンドボックスからホスト祖先を探せなかった問題に対し、spawn 管理下ではフックの登録申請をホスト側で検証する方式に変更しました。
spawn 管理下の Claude Code と Codex CLI でも、通知による依頼・返信・既読を実機で確認しました。
詳細は [検証記録](docs/VALIDATION.md) を参照してください。

## ビルド

```sh
nix build
nix flake check
./result/bin/seatwire --help
```

Nix を使わない開発時は Node.js 24 と tmux が必要です。
`npm install` は不要です。

```sh
node --test tests/*.test.mjs
node src/cli.mjs --help
```

## Home Manager

flake 入力にこのリポジトリを追加し、モジュールを import します。
公開前は `path:/absolute/path/to/seatwire` を使えます。

```nix
{
  inputs.seatwire.url = "path:/absolute/path/to/seatwire";
  # Home Manager の modules に追加:
  # inputs.seatwire.homeManagerModules.default
}
```

```nix
{
  programs.seatwire.enable = true;
}
```

これにより CLI、両エージェント向け Skill、設定断片、通知用ユーザーサービスが導入されます。
既存ファイルと衝突する場合、Home Manager の通常の衝突検査で停止します。
既存の Claude/Codex 設定は自動で書き換えません。

既に Home Manager がエージェントの設定を管理している場合は、次を追加できます。
この連携オプションは本リポジトリの lock に固定した Home Manager の `programs.claude-code.settings` と `programs.codex.settings` を利用します。
エージェント本体の enable とパッケージ選択は利用者側で設定してください。
連携を有効にする場合、各エージェントの `mutableSettings` は false が必要です。
可変設定への追記では無効化時にフックが残るため、module の assertion で拒否します。

```nix
{
  programs.seatwire = {
    enable = true;
    integrateClaude = true;
    integrateCodex = true;
  };
}
```

手動管理の設定を移行する場合は、設定内容を確認して Home Manager 側へ統合してください。
`~/.config/seatwire/hooks.json` に生成される `claude` / `codex` セクションも参照できます。
Codex の未信頼フックは実行されないため、エージェント自身の信頼確認が必要です。

### Claude の設定を Home Manager で管理していない場合

`claudePlugin` を有効にすると、`~/.claude/skills/seatwire` を Claude Code の skills ディレクトリ用プラグインとして導入します。
プラグインには Skill と、同じパッケージの `seatwire hook --kind claude-code` を実行する SessionStart フックが入ります。
`~/.claude/settings.json` は変更しません。
Claude Code はこのディレクトリをその場で読み込むため、フックのコマンドは Home Manager の世代と一緒に更新・撤去されます。
ストアパスを可変の settings.json へ手で写す方法と違い、GC 後に古いパスが残りません。
既定は無効で、`integrateClaude` との同時指定は assertion で拒否します。

```nix
{
  programs.seatwire = {
    enable = true;
    claudePlugin = true;
  };
}
```

Claude Code の公式ドキュメントでは、`~/.claude/skills/` 配下の `.claude-plugin/plugin.json` を持つディレクトリは `<名前>@skills-dir` として読み込まれ、利用者自身のディレクトリには信頼確認がありません。
管理設定（managed settings）で skills ディレクトリのプラグインが禁止されている環境では読み込まれません。
有効化後に起動した Claude で `/plugin` を開くと、`seatwire@skills-dir` を確認できます。

### Codex のフックを手で追加する場合

Codex の設定を Home Manager で管理していない場合、`~/.codex/hooks.json` の `SessionStart` にフックを追加し、Codex の `/hooks` で信頼してください。
Codex はフック定義のハッシュに対して信頼を記録するため、コマンドの書き方で更新時の扱いが変わります。

- `~/.config/seatwire/hooks.json` のストアパス（`/nix/store/…/bin/seatwire hook --kind codex`）: 信頼したコードに固定されますが、seatwire を更新するたびに再レビューが必要です。
  手で書き写した場合は、更新後に書き換えないと GC でパスが消えてフックが失敗します。
- プロファイルの固定パス（`~/.nix-profile/bin/seatwire hook --kind codex` など、`home.profileDirectory` の `bin`）: 更新しても一度の信頼が有効なままです。
  その代わり、信頼はコマンド文字列に対するもので、更新後に実行されるコードは再レビューされません。

どちらを選ぶかは利用者の判断です。
seatwire はフックの信頼を自動では変更しません。

```sh
codex
claude
systemctl --user status seatwire
seatwire status
```

フック連携を有効にすると、通常起動でも種類とセッション UUID から名前を自動登録します。
チーム指定を省略すると `default` を使います。
エージェント内では以下のコマンドで協業できます。

```sh
seatwire peers
seatwire send --to <peers が返した名前> 'この変更をレビューして'
seatwire inbox
seatwire reply 1 '確認結果です'
seatwire ack 1
```

`peers` は同じチームで、現在の作業ディレクトリに登録されたセッションを表示します。
生存を確認できれば `online: true`、別の PID namespace や共有 Codex app-server により個別セッションの状態を確認できなければ `online: null` を返します。
終了を確認できた宛先は通常表示から除きます。
`peers --all` は同じチームの別ディレクトリとオフラインの宛先も表示します。
ディレクトリはシンボリックリンクを解決して比較し、Git worktree 間を自動で同一視しません。
`whoami` で現在の名前を確認できます。
送受信時は、環境変数のセッション ID（Codex は `CODEX_THREAD_ID`、Claude Code は `CLAUDE_CODE_SESSION_ID`）があれば、その ID で登録された受信箱だけを使います。
環境変数がなければ、エージェント祖先から自分を特定します。
複数候補があれば失敗し、チームや名前を明示するよう案内します。
Claude の Bash から `codex exec` を起動した場合など、子が親のセッション ID を受け継ぐことがあります。
異なるセッション ID が環境に複数あるときは、子が未登録でも親の受信箱を選ばずに失敗します。
この場合も `--team` と `--name` を明示してください。
従来の `SEATWIRE_TEAM` と `SEATWIRE_NAME` による役割指定も使えます。
`reply` は自分が受信したメッセージだけを対象にし、既読にはしません。

`send` と `reply` は、宛先の通知状態を `notification` で返します。

- `pending`: ホストの通知サービスが宛先に inbox の確認を促します。
  処理したことの証拠にはならず、`ack` か返信で確認します。
- `none`: 宛先に登録済みのセッションがなく、通知されません。
  宛先が inbox を確認するまで未読で残ります。
- `recipient not running`: 登録されたセッションが終了しています。
  再開などで再登録されるまで通知されません。
- `failing`: 直近の通知が失敗しています。
  `error` に理由があり、通知サービスがバックオフして再試行します。

`status` と `doctor` の各 agent 行には、`notification` として通知状態と未読の内訳も表示します。
`acceptedUnread` は現在の通知成功 cursor 以下の未読件数、`pendingUnread` は現在の通知成功 cursor より後にある未読件数で、再試行対象を含みます。
`retry` は cursor をリセットするため、過去に受付済みの未読も `pendingUnread` に含まれます。
`notification.state` は `idle`（未読なし）、`no-target`、`offline`、`in-flight`（リース中）、`failed`、`pending`（再試行対象を含む）、`accepted-unacknowledged`（受付済み未 ack）を区別します。
現在の cursor 以下の未読と再試行対象を含む cursor 後の未読が混在する場合は `pending` など現在の試行状態を示し、両方の件数を残します。
`online: null` は生存不明であり、`pending` でも受信者が稼働中とは限りません。
`in-flight` は DB のリース状態であり、外部 I/O が進んでいる証明ではありません。
受付は transport が成功と返したことを示し、内容取得や処理完了を示しません。
過去の `error` は履歴として残ることがあり、現在の cursor より後の未読がなければ `failed` にはしません。
未読への自動再送は追加せず、必要なら原因を直して `retry NAME` を実行してください。

Claude Code の `/clear` は、同じプロセス・同じ messaging socket のまま新しいセッション UUID を開始します。
新しいセッションが登録されると、同じプロセスとソケットを持つ以前のセッションの登録からは通知先だけを外します。
以前のセッションのメッセージは受信箱に未読のまま残り、新しい会話へは通知しません。
`status` の `error` に引き継いだ名前を表示し、以前のセッションを再開すれば再び登録されます。

手動起動したセッションでは、セッション開始フックがセッション ID・祖先プロセス・通知先を検証して登録します。
この経路ではホスト祖先を参照できないサンドボックス内からの登録は失敗します。
`spawn` 管理下の登録は、後述するホスト照合の経路を使います。
名前はチーム内で一意で、別の生存セッションによる上書きを拒否します。
Codex の `actas --kind codex` は実行環境の `CODEX_THREAD_ID` とエージェント祖先を確認できる場合に利用できます。
Claude は SessionStart 入力の session_id と環境の messaging socket/token を使います。
フックの環境に `CLAUDE_CODE_SESSION_ID` があれば、入力の session_id と一致することも確認します。
推測したセッション ID では登録しません。

エージェントのサンドボックスから DB にアクセスできるよう、必要な場合は `$XDG_STATE_HOME/seatwire` を許可対象へ明示的に追加してください。
seatwire はサンドボックス設定を緩和しません。
書き込みが拒否された場合、コマンドは `cannot create state directory <パス>` または `cannot write state database <パス>` で失敗し、許可が必要なディレクトリを示します。
Codex では、`~/.codex/config.toml` の permission profile で書き込み許可を加えられます。
次の例は、組み込みの `:workspace` を継承し、既定の状態ディレクトリへの書き込みを加えます。
`XDG_STATE_HOME` を設定している場合は、`$XDG_STATE_HOME/seatwire` の絶対パスに置き換えてください。

```toml
default_permissions = "seatwire"

[permissions.seatwire]
extends = ":workspace"

[permissions.seatwire.filesystem]
"~/.local/state/seatwire" = "write"
```

この profile は codex-cli 0.166.0 の `codex sandbox -P seatwire` で検証しました。
通常起動で `default_permissions` により選ばれることは確認していません。
Codex の公式ドキュメントは、`default_permissions` と `[permissions]` を `sandbox_mode` や `[sandbox_workspace_write]` と併用しないよう求めています。
既に `[sandbox_workspace_write]` を使っている場合は、その `writable_roots` に同じディレクトリを加える方法もありますが、こちらは未検証です。
状態ディレクトリがまだない場合、許可を加えてもサンドボックス内からは作成できません。
先にホストで `seatwire status` などを一度実行するか、通知サービスを起動して作成してください。
通知サービスには Codex 実行ファイルが必要です。
未設定時は、サービスの PATH（Home Manager のプロファイルの `bin`、`/usr/bin`、`/bin`）から `codex` を探します。
それ以外の場所にある場合は、`programs.seatwire.codexExecutable` に絶対パスを指定してください。
指定した値はサービスの `SEATWIRE_CODEX` 環境変数になります。

```nix
{
  programs.seatwire.codexExecutable = "/opt/codex/bin/codex";
}
```

Volta で導入した Codex は `~/.volta/bin/codex` の shim です。
この shim は、`HOME` とサービス相当の最小の `PATH` だけを与えた環境でも `codex queue --help` を実行できました。
その場合は `"${config.home.homeDirectory}/.volta/bin/codex"` を指定できます。

## メッセージング

まず各受信者のメールボックスを登録します。
オフライン登録でもメッセージを保持できます。

```sh
seatwire --team demo --name implementer register --kind claude-code
seatwire --team demo --name reviewer register --kind codex
seatwire --team demo --name implementer send --to reviewer 'この変更をレビューして'
seatwire --team demo --name reviewer inbox
seatwire --team demo --name reviewer ack 1
seatwire --team demo --name reviewer send --to implementer 'レビュー結果です'
seatwire --team demo --name implementer history
seatwire status
seatwire doctor
```

`inbox` は既読にしません。
取得して処理した ID を `ack` で明示します。
`history` はその名前の送受信履歴を返します。
送信者・受信者名はローカルユーザー内の役割であり、同一 OS ユーザー間の認証境界ではありません。

通知サービスを手動実行する場合は `seatwire daemon` を使います。
通知には inbox の確認指示だけを含めます。
通知失敗は `status` に記録され、バックオフして再試行します。
通知完了と既読は別です。
外部送信後のクラッシュなど、結果が不明な場合には通知が重複することがあります。

## spawn / despawn

```sh
seatwire --team demo spawn codex reviewer --boot-prompt '変更差分をレビューして'
seatwire --team demo spawn claude-code implementer
# ホストによる通知先登録まで待つ（最大 30 秒）:
seatwire --team demo spawn codex auditor --wait-ready --ready-timeout 30000
seatwire --team demo despawn reviewer
seatwire --team demo despawn reviewer --force
# 正確な既存セッション UUID を指定して再開:
seatwire --team demo spawn codex reviewer --resume SESSION_UUID
```

起動結果には接続用の tmux コマンドを表示します。
専用サーバーのため、既存の tmux セッションを使いません。
各エージェントの信頼確認・ログイン・権限確認は接続先の画面で行います。
起動成功はフック登録やモデルの処理開始を意味しません。
`--wait-ready` はフックの申請をホストが検証して通知先に登録するまで待ちます。
通知の受信やモデルの反応を確認する機能ではありません。
タイムアウト時もエージェントは残るため、`seatwire status` の `registration` と `error`、tmux 内の信頼確認を確認してください。
信頼確認には別の端末から tmux に接続できます。

spawn は DB に起動を予約してコミットしてから tmux を呼び出すため、起動中のフックによる書き込みをロックしません。
フックは起動 ID とセッション ID を DB に申請し、ホストの daemon または `--wait-ready` が専用 tmux サーバーとエージェントのプロセス開始情報を照合します。
フック自身がホストの親プロセスを探す必要はありません。
別の起動 ID、プロセス開始情報、ソケットに変わっていれば登録を拒否します。
起動途中で CLI が終了した場合、`status` に `abandoned` が表示され、`despawn` で同じ起動と確認できたものだけを整理できます。

起動 ID・チーム・名前はフックのコマンドに埋め込まず、エージェントの環境変数（`SEATWIRE_LAUNCH_ID` など）で渡します。
そのため、同じ seatwire のビルドと状態ディレクトリであれば、spawn が渡すフック定義は起動ごとに同一です。
Codex はフック定義のハッシュに対して信頼を記録するため、一度信頼すれば次の spawn では再レビューを求めません。
seatwire を更新して実行ファイルのパスが変わると、定義が変わるので再レビューが必要です。
Codex は `--no-daemon` で起動し、フックの環境とセッションの寿命をペインのプロセスに持たせます。
共有の app-server を使わないため、`status` と `peers` は個別セッションの生存を `online: true` / `false` で示せます。

フックを初めて信頼する起動では、`--boot-prompt` の最初のターンがレビュー画面の操作より先に始まり、そのセッションの SessionStart から seatwire のフックが除かれることがあります。
この場合、そのセッションは登録されないため、信頼した後に despawn して spawn し直してください。
2 回目以降の起動では、レビュー画面は表示されません。

tmux は起動元の環境をペインに引き継ぎます。
spawn は起動元セッションを指す変数（`CLAUDE_CODE_SESSION_ID`、`CLAUDE_SESSION_ID`、`CODEX_THREAD_ID`、`CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_MESSAGING_TOKEN`、`CLAUDECODE`、`CLAUDE_PID`）を外してからエージェントを起動します。
Claude から spawn した Codex に、親 Claude の通知用ソケットとトークンは渡りません。

通常の despawn は Ctrl-C を送り、終了未確認であることを返します。
自動的な強制終了は行いません。
`--force` は記録したプロセス開始情報・ソケットと一致する専用セッションだけを終了します。
エージェントの終了を最大 10 秒待ち、終了を確認できれば `stopped`、できなければ `forced stop requested; agent still exiting` を返します。
エージェントが生きている間は同じ名前の spawn を拒否するため、`stopped` の後は同じ名前ですぐに `--resume` できます。
終了した起動記録が残っている場合、despawn で整理してから再度 spawn します。
管理下 launch で異なる session UUID を観測すると、初回 pending を含め、その launch の自動通知登録を失効させます。
旧通知先と通知リース、pending request を同じ transaction で無効化し、未読と ack 履歴は保持します。
失効は DB の launch レコードに保存し、同じ launch 内では元 UUID の古い SessionStart も `source: resume` の入力も復旧に使いません。
これらの入力だけでは古いイベントの再送と正規 resume を区別できないためです。
復旧には、明示的に旧 launch を終了してから、新しい managed launch で元 UUID を resume してください。
旧 launch が終了していない場合は、停止を確認するまで同じ名前での復旧を進めないでください。
同一 UUID の通常の重複 SessionStart は通知進捗を維持します。
固定名の mailbox を新 UUID に自動継承することはありません。
失効前に claim を取得した worker の外部 I/O は、失効後に実行または完了する可能性があり、取り消せません。
その worker の完了による DB 書き戻しは generation / lease fencing で拒否します。
詳細は [会話切り替えの設計](docs/SESSION_SWITCH.md) を参照してください。

## 更新・無効化・データ

入力の更新は `nix flake update seatwire` と `home-manager switch` で適用します。
このリポジトリ自身の開発では `nix flake update` が依存入力を更新します。

`programs.seatwire.enable = false;` にして switch すると、管理対象の Skill、hook 設定断片、追加したフック設定、サービス定義と CLI が撤去されます。
他の設定が同じ CLI やフックを導入している場合、その設定は別途管理してください。
Home Manager のサービス切替を有効にしている環境では通知サービスも停止対象になります。
ユーザーが `systemd.user.startServices = false` を設定している場合は手動停止が必要です。

SQLite は `$XDG_STATE_HOME/seatwire/messages.sqlite3`、未設定時は `~/.local/state/seatwire/messages.sqlite3` に残ります。
再導入すると既存データを読み込みます。
起動したエージェントを無効化時に kill しません。
作業中のエージェントを継続する場合、古い起動コマンドやフックは旧パッケージを参照し得るため、Nix GC 前に作業を終えてください。

完全削除は通知サービスと利用中のエージェントを停止し、必要なバックアップを取ってから、上記の `seatwire` データディレクトリを明示的に削除します。
実行中の DB の単一ファイルコピーは避け、SQLite backup API または停止後のコピーを使ってください。
Nix のロールバックは DB を巻き戻しません。
未対応の schema version は変更せずエラーにします。
現在の schema 2 は schema 1 から登録申請テーブルを追加して自動移行します。
schema 1 の旧バイナリへ戻すと起動を拒否するため、ロールバック時は対応バイナリまたは移行前のバックアップが必要です。
`--state-home /absolute/path` で、環境変数に依存せず状態の基準ディレクトリを指定できます。
DB はその下の `seatwire/messages.sqlite3` に配置され、spawn の子プロセスとフックにも同じ基準ディレクトリを渡します。

## 自動検証と WSL

GitHub Actions は固定した Nix 入力で `nix flake check`、一時 HOME の導入・撤去・再導入、稼働中のユーザーサービスの停止を検証します。
サービス検証は `bash tests/home-manager-systemd.sh` で実行でき、稼働中の systemd ユーザーマネージャーが必要です。
既存サービスとの衝突を避けるため、一意な名前と一時 HOME でモジュールのユニット定義を検証し、終了時にテスト用リンクを撤去します。
実エージェントの認証・フック信頼・モデル応答は CI の対象に含みません。

WSL でも通知用ユーザーサービスには動作中の systemd が必要です。
`systemctl --user is-active default.target` で確認できます。
利用できない環境ではホストで `seatwire daemon` を実行してください。
今回の検証環境は WSL2 上の Ubuntu 24.04.5 LTS（カーネル `6.18.54.1-microsoft-standard-WSL2`）です。
この環境で自動テスト、Home Manager の導入と撤去、通常起動した Claude Code との往復通信を確認しました。
待機中の通知による双方向応答と、停止したセッションの再開後の通信も確認しました。
Windows ネイティブ実行は未検証です。

## 設計・出典・候補名

[ARCHITECTURE.md](ARCHITECTURE.md) に言語選定と状態管理、[THIRD_PARTY.md](THIRD_PARTY.md) に再利用コードの出典を記録しています。
agmsg の通知 I/O 2 モジュールを MIT ライセンスとともに収録しています。

候補名は `seatwire`、`peerwire`、`agwire`、`seatpost` です。
seatwire はエージェントの役割を割り当てる「席」と通信を連想でき、暫定名として使用しています。
名称の利用可能性・商標は未調査で、読み方も確定していません。

## 通常起動と sandbox の切り分け

人間が通常起動したセッションでも、フックの実行環境とエージェントがツールとして実行するコマンドの環境は異なり得ます。
Codex の `/hooks` で対象フックの信頼状態を確認してください。
起動ログの `SessionStart Completed` だけでは seatwire の登録成功を確認できません。
今回の Codex 0.166.0 の対話起動では、信頼済み SessionStart フックは最初のユーザー入力時に実行されました。
画面を開いただけの状態では登録されないため、最初に短い入力を行ってから、ホスト側の `seatwire status` で登録を確認します。
`spawn --wait-ready` でも、必要なら `--boot-prompt` を指定して最初のターンを開始してください。

登録済みのセッション UUID が渡されるコマンドは、ホスト PID が sandbox から見えなくてもメールボックスを利用できます。
これは実際の Codex workspace-write sandbox で受信と返信を確認しています。
一方、sandbox 内での未登録セッションの `actas` は、ホスト祖先を特定できなければ失敗します。
状態ディレクトリへの読み書き権限も別途必要です。
seatwire は権限やフックの信頼設定を自動で変更しません。

通知が止まった場合は、ホストで `seatwire status` の `unread`、`error`、`retry_at`、`lease_until` を確認してください。
原因を解消した後、`seatwire retry NAME` で未読メッセージの通知を再試行できます。
通知中の場合は現在のリースが終了するまで再試行を拒否します。
既読状態やメッセージ本文は変更しません。
同一内容の SessionStart 再実行では通知済み位置を保持し、プロセスや通知先が変わる再開では新しい通知世代に切り替えます。
