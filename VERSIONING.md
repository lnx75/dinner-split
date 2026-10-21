# 版本规则

使用 `主版本.功能阶段.小更新` 三段整数。当前版本为 `1.1.4`。

小功能、修复、界面及部署优化只增加最后一位；明显较大的功能阶段升级增加中间位，最后一位归零；重大产品或不兼容升级增加第一位。

产品更新在 `public/releases.js`，`CURRENT_VERSION` 取首项，须与 `package.json` 一致。发布前执行 `npm test`、`npm run check:version`、`npm run build`。运行数据修订计数与产品版本独立。
