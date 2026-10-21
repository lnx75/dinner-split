// Public product history contains no runtime data or deployment identifiers.
export const RELEASES = [
  {
    version: '1.1.4', date: '2026-10-20', title: '按菜分账，回到简单直观',
    changes: [
      '首页直接添加菜品或费用，一次填写名称、金额并勾选实际参与的人。',
      '晚到成员不会分摊之前的菜，每道菜的参与人独立选择。',
      '成员默认保留，增删改集中在管理后台；清空本次账单只清除费用和垫付。',
      '移除聚餐归档、聚餐管理、定稿及自动备份，收起辅助操作并精简入口。',
    ],
  },
  {
    version: '1.1.3', date: '2026-10-20', title: '开源与 Docker 部署',
    changes: [
      '提供可自行托管的开源版本与 Docker 部署配置。',
      '首次启动由部署者设置管理员密码，不包含预置私人账户、账单或上传图片。',
      '支持人民币精确分账、多人协作、成员头像、垫付结算、聚餐历史和后台管理。',
    ],
  },
];
export const CURRENT_VERSION = RELEASES[0].version;
