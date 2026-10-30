# seatwire

Claude Code と Codex CLI の間でメッセージを交換する、Linux / WSL 向け CLI です。
暫定名は seatwire です。
Node.js 24 の組み込み SQLite を使い、実行コードと永続データを分離します。

現状は初期実装です。
送受信・既読・並行アクセス・通知 I/O・tmux 操作・Home Manager の撤去を自動テストしています。
実機では Codex の送信を受けて Claude が通知に反応し、既読・返信するところまで確認しました。
Codex のサンドボックスからホスト祖先を探せなかった問題に対し、spawn 管理下ではフックの登録申請をホスト側で検証する方式に変更しました。
この方式の結合テストは通りましたが、変更後の双方向実機通知は未検証のため P0 は未完了です。
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

```sh
SEATWIRE_TEAM=demo SEATWIRE_NAME=reviewer codex
SEATWIRE_TEAM=demo SEATWIRE_NAME=implementer claude
systemctl --user status seatwire
seatwire status
```

手動起動したセッションでは、セッション開始フックがセッション ID・祖先プロセス・通知先を検証して登録します。
この経路ではホスト祖先を参照できないサンドボックス内からの登録は失敗します。
`spawn` 管理下の登録は、後述するホスト照合の経路を使います。
名前はチーム内で一意で、別の生存セッションによる上書きを拒否します。
Codex の `actas --kind codex` は実行環境の `CODEX_THREAD_ID` とエージェント祖先を確認できる場合に利用できます。
Claude は SessionStart 入力の session_id と環境の messaging socket/token を使います。
推測したセッション ID では登録しません。

エージェントのサンドボックスから DB にアクセスできるよう、必要な場合は `$XDG_STATE_HOME/seatwire` を許可対象へ明示的に追加してください。
seatwire はサンドボックス設定を緩和しません。
通知サービスには Codex 実行ファイルが必要です。
Home Manager のプロファイルに Codex を導入するか、サービスの `SEATWIRE_CODEX` 環境変数に絶対パスを指定してください。

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

通常の despawn は Ctrl-C を送り、終了未確認であることを返します。
自動的な強制終了は行いません。
`--force` は記録したプロセス開始情報・ソケットと一致する専用セッションだけを終了します。
終了した起動記録が残っている場合、despawn で整理してから再度 spawn します。
`/clear` による別 UUID への切り替えは生存中の所有者変更として拒否します。
その場合はセッション終了後に起動し直してください。

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
WSL 自体での実機検証は未実施です。

## 設計・出典・候補名

[ARCHITECTURE.md](ARCHITECTURE.md) に言語選定と状態管理、[THIRD_PARTY.md](THIRD_PARTY.md) に再利用コードの出典を記録しています。
agmsg の通知 I/O 2 モジュールを MIT ライセンスとともに収録しています。

候補名は `seatwire`、`peerwire`、`agwire`、`seatpost` です。
seatwire はエージェントの役割を割り当てる「席」と通信を連想でき、暫定名として使用しています。
名称の利用可能性・商標は未調査で、読み方も確定していません。
