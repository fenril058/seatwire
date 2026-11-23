# 名前と通知先の所有権保護

既存targetを変更する登録とmanaged開始は、所有権専用のprocess観測を使う。
通知配送やonline表示で使う既存aliveのbooleanは変更しない。
PID namespaceとprocfsの対応を確認し、processの一致、終了、不一致、観測不能を区別する。
procがENOENTでも、それだけで終了とせず、同じPID namespaceでsignal 0がESRCHを返すことを確認する。
signal 0は実際のsignalを送らず、processの存在を照会する。

## 登録の判断

| 条件 | 動作 |
| --- | --- |
| 既存targetなし | 新規登録と明示offline操作を従来どおり扱う |
| 同一kindで保存JSONと完全に同一のtarget | 冪等登録を維持し、generation、通知進捗、leaseを変更しない |
| 生存する既存ownerを確認 | 別UUID、別process、別namespace、offlineへの変更を拒否する |
| 同じprocessとUUIDを確認したmetadata変更 | 既存のtarget変更規則で更新する |
| 終了または正しい観測範囲でwitness不一致を確認 | UUID重複等の既存制約を満たせば登録とresumeを許可する |
| 権限不足、namespace不明、不正な記録、観測不能 | 完全同一targetの再提示を除き、変更を拒否して既存行を保持する |

拒否時はagents、launches、pending、messagesを登録transactionの途中状態にしない。
reconcileが拒否を捕捉した場合は、従来の規則でpendingのerrorを記録できるが、成功扱いで消したり既存targetを解除したりはしない。
同じUUIDやsource resume、明示nameだけで観測不能を回避することはできない。
既存UUIDの全team重複検査とexpected record/payloadの照合も、冪等登録によって迂回しない。

## managed lifecycle

新しいmanaged記録はstarter、server、agentのPID namespaceをJSONへ記録する。
DB schemaは2のままである。
managed開始は既存ownerが観測不能ならreservationやtmux呼出の前に拒否する。
despawnはstarterやserverの観測失敗をalready stoppedへ読み替えて管理記録を削除しない。
socketの観測エラーも不存在として扱わない。
確認できたmanaged sessionへの通常interruptと明示forceは維持する。

新しい自動名を使うclear/fork、Claudeのprocess/socket交代、managed UUID変更によるrevocationは従来の別処理である。
これらの明示的な会話交代を、観測失敗を理由とする自動解除へ一般化しない。
spawn.exitedの停止後待機、通知配送、online表示など他のalive利用は、この変更では改修していない。
Issue #6のsocket削除とheartbeat GCも含めない。

## 互換性の制限

namespace未記録や不正なwitnessを持つ旧targetは、安全な所有権変更の根拠にならない。
完全一致の再提示、UUIDによるmailbox読取、offline mailbox自体の操作は維持するが、別targetへのresumeが保留になる場合がある。
実際には旧processが終了していても、呼出側がその情報を観測できなければ新規targetへの変更は拒否する。
古いUUID対応を推測で復元したり、設定を弱めたり、DBやtargetを自動解除して回避したりはしない。
通常のhost経路で再確認し、所有権を証明できない旧記録は個別レビューの対象とする。

## 隔離テストの証明条件

観測拒否の回帰は、生存中の非エージェントNodeをownerとし、新規fixture Nodeのpermission modelからだけ旧procを読めなくして確認する。
同じnamespaceでERR_ACCESS_DENIEDとなり、legacy aliveはfalseでも所有権変更が拒否されることを検証する。
拒否後のagents、launches、pending、messages、read_at、通知進捗を全列比較する。

終了の正例に使っていたwitness expiredは、通常終了した非エージェントprocessの実PID、witness、namespaceへ置き換えた。
resumeとcompactのteam/name保持、通知generationのfence、管理予約の復旧の期待値は維持する。
生存やmetadata更新の正例には実namespaceを補った。
別namespaceの表示fixtureは、登録APIで生存ownerのnamespaceを変更する代わりに、隔離DBへ観測条件を直接設定する。
表示、通知、ackの既存assertは弱めていない。
不正なwitnessを観測不能として保護するテストは別に維持する。
