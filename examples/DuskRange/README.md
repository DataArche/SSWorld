# 暮林行动 / Dusk Range

SSWorld / SSDL 户外移动靶射击游戏。75 秒挑战，六个移动靶，12 发弹匣。

预览：http://127.0.0.1:8880/projects/DuskRange_0912/index.html

开始行动启用鼠标锁定；内嵌预览可选择「键盘模式」。WASD 移动，方向键瞄准，空格或左键射击，Q 或右键放大，R 换弹，Esc 暂停，Shift 加速。

靶心 150 分、外环 100 分，3.5 秒内连续命中叠加奖励，最高额外 200 分。目标 3000 分。未命中会中断连击。换弹耗时 1.4 秒。

scene.ssdl：相机、灯光、目标与状态。Camp.ssdl：营地、植被和材质。logic.mjs：输入、命中、碰撞、计分和 HUD。host_interfaces.json：SSDL 宿主契约。

assets/ 下模型与纹理均为本项目生成，无外部素材依赖。运行 python dusk_assets.py 可重新生成；运行 node dusk_game_test.mjs 可检查游戏规则。使用 SSWorld compile / preview 重新加载项目。

这是单人训练靶场原型；没有音效、敌人 AI 或联网对战。武器和 HUD 是屏幕叠加，场景由 SSEngine 实时渲染。碰撞覆盖主要箱体、混凝土掩体、集装箱和场地边界。
