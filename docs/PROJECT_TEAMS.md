# Project team selection

単一のUser SessionStart Hookを維持し、ユーザー所有設定でGit worktree rootとteamを対応させる。
project Hookを追加したり、共有app-serverの環境を変更したりはしない。
DB schema 2、メッセージ、ack、notification.state、lease、generationの意味は維持する。

## 保証範囲と互換性

設定済みworktreeだけを厳格化する。
設定のないworktreeは、source省略を含む既存Hook入力との互換性を維持する。
ただし、DB全体に残る同じsession UUIDの重複や、明示指定と既存登録の矛盾は両経路で拒否する。

解除でtargetがNULLになったcustom名の行には、元のsession UUIDが残らない。
sourceのない入力では、そのUUIDのresumeと新規UUIDを区別できない場合がある。
従来経路はこの情報欠落を解消せず、default等へ登録する可能性が残る。
全worktreeでこの推測を防げるという保証はしない。
既存の登録や履歴を移動・削除して問題を隠さない。

## 設定とrootの観測

設定は `$XDG_CONFIG_HOME/seatwire/projects.json`、未指定時は `~/.config/seatwire/projects.json` に置く。
形式は `{"version":1,"projects":{"/absolute/worktree/root":"team"}}` とする。
通常ファイル、本人所有、group/other書込不可、64 KiB以下を要求する。
設定ファイル自体のsymlinkは許可しない。
キーは実在するworktree rootの絶対パスとし、realpathで同一になる重複は拒否する。
設定がない場合と、不正・読取不能な場合を区別する。
不正な設定は未設定として扱わない。

Hook入力cwdを正規化し、Gitの `rev-parse --show-toplevel` でそのworktree rootを求める。
継承されたGIT_DIR / GIT_WORK_TREE / GIT_CONFIG_*等はGit子プロセスから除き、別のcheckoutや設定に誘導されないようにする。
Gitの終了status・timeout・出力サイズを検査し、観測失敗をdefaultへ読み替えない。
Git管理外と確認できたディレクトリは対応なしとする。
共通Git directoryではなく個別worktree rootの完全一致で選択するため、専用worktreeだけを設定できる。
rootに対応がなければ親プロジェクトのteamを継承しない。
既存のtarget.projectはHook入力cwdのままで、peersの作業ディレクトリによる絞り込みも変えない。
設定ファイルがないか空の対応表なら、Gitを呼ばず従来経路を使う。

Codex 0.169.0の公開コードではSessionStartのcwdはturn_context.cwdから生成される。
rootをapp-serverのprocess.cwdや環境変数から推測しない。
合成Hookの回帰では、Nodeの実行cwdと入力cwdを異なるworktreeにし、入力cwdのrootが選ばれることを確認する。
これは新しい実エージェントによる複数worktree検証を行ったという意味ではない。

## 登録の順序

設定ファイルとrootの観測はwriter transactionの前に行い、その結果またはエラーを渡す。
UUIDの照合と登録は同じBEGIN IMMEDIATE内で行う。
設定観測が失敗した場合、設定の有無を推測して登録しない。

1. 設定済みworktreeでは、sourceがstartup / resume / clear / compact / forkのいずれかでなければ停止する。
2. teamを限定せず、DB全体から正規のsession UUIDを照合する。
   複数候補やagent kindの不一致は拒否する。
3. 一意の既存登録があれば、そのteam/nameを維持する。
   明示team/nameがそれと矛盾すれば拒否し、project設定の変更は適用しない。
4. 既存登録がなく設定済みなら、startup / clear / forkだけを初回登録として扱う。
   resume / compactは元のidentityを復元できないため拒否する。
   UUID由来の自動名mailboxだけが残っている場合も、解除済みの可能性として拒否する。
5. 新規登録では `--team`、Hook環境SEATWIRE_TEAM、project設定、defaultの順にteamを選ぶ。
   `--team`がなく環境とproject設定が違う場合は拒否する。
6. store.registerも同じUUIDを別team/nameへ重複登録できないようにする。
   既存の重複データは自動修復せず、read/historyのために保持する。

ここでの `--team` は実際のseatwireコマンドの引数であり、Codexの新しい起動引数ではない。
明示teamは新規登録のproject選択に優先するが、設定済みworktreeのsource検査と既存UUIDの帰属検査は迂回しない。
Hook環境の指定と、UIを起動した端末だけにある環境変数は区別する。
共有app-serverがclientのSEATWIRE_TEAMを受け取るという仮定は置かない。

managed launchは既存のlaunch記録とteam/nameを使い、project設定で置き換えない。
同じtargetの重複Hookではgeneration・通知進捗・leaseを保持する。
通知先が変わった正当なresumeでは既存のgeneration更新規則を使い、メッセージとread_atは保持する。

## sourceの意味

| source | 設定済み・未登録UUID | 設定済み・既存UUID |
| --- | --- | --- |
| startup | 初回登録候補 | 既存identityを維持 |
| clear | 新UUIDの初回登録候補 | 重複イベントなら既存identityを維持 |
| fork | 新UUIDの初回登録候補 | 重複イベントなら既存identityを維持 |
| resume | 復元不能として拒否 | 既存identityを維持 |
| compact | 復元不能として拒否 | 既存identityを維持 |
| 省略・未知 | 拒否 | 拒否 |

sourceはagentが渡す正規のライフサイクル入力として扱う。
sourceだけでteamを上書きせず、既存UUIDを必ず先に照合する。
設定のない従来経路はsource検査を追加しない。

## 制約と本番適用

DB schemaを変えないため、旧版writerや直接SQLに対する新しい一意制約をDB側に追加するものではない。
新しいregister経路同士は同一writer lockで照合するが、旧版が後から重複を作ることまで保証しない。
対処のために既存sessionや共有serverを自動終了しない。
通常checkoutのteamを変更する設定を自動生成しない。
実協業検証用の設定は専用worktreeにだけ置き、送信前にteam・session UUID・state・Hook参照先・実際の登録を照合する。

設定データの変更がCodexのHook定義hashのレビュー対象になるとは仮定しない。
設定は利用者が別途レビューするデータであり、package更新でcommandのstore pathが変われば手動trustレビューが必要になる。
この機能の開発・テストはHome Manager switchや既存Hookの変更、サービス再起動を行うものではない。
Stage Cは未完了であり、実エージェントによるE2Eは別途承認が必要である。
Issue #6とheartbeat GCは対象に含めない。

## 原典

- [Codex 0.169.0のsource選択](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core/src/session/session.rs#L2215-L2226)
- [SessionStartのcwd生成](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core/src/hook_runtime.rs#L152-L159)
- [既存Claudeのsource観測記録](VALIDATION.md#claude-session-uuid)
