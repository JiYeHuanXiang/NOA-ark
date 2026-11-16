window.__ModuleLoader__.load({
  id: 'noa-ark',
  factory: (require) => {
    const React = require('react');
    const NS = 'noa-ark.settings';
    const inject = ['slots', 'locale', 'configForms'];

    const zh = {
      title: 'NOA 方舟 OneBot 桥',
      settingsLabel: 'NOA 方舟',
      intro: '把 QQ 官方机器人转成 OneBot v11，并在 OneBot 客户端与 dsh 之间做回复隔离。',
      onebot: 'OneBot 服务',
      enable: '启用 OneBot v11 服务',
      mode: 'WS 模式',
      modeForward: '只开正向服务端',
      modeReverse: '只连反向地址',
      modeBoth: '正向 + 反向',
      wsPort: '正向 WS 端口',
      wsPath: '正向 WS 路径',
      reverseUrls: '反向 WS 地址（每行一个）',
      tokenHint: '鉴权令牌请在 profile 配置文件中设置；设置页不回显密钥。',
      isolation: 'dsh 与 OneBot 的回复隔离',
      isolationAuto: '自动：有 OneBot 客户端在线时暂停 dsh 回复',
      isolationAlways: '始终：dsh 不再回复 QQ 消息',
      isolationOff: '关闭：dsh 与 OneBot 都可能回复',
      isolationHint: '自动模式需要至少一个 OneBot 客户端保持连接；桥启动时的第一条消息可能仍由 dsh 处理。始终模式会丢弃 dsh 侧回复，请确认 OneBot 客户端已接管。',
      dshChat: 'dsh AI 对话',
      dshChatEnable: '允许 noa_dsh_chat 调用 dsh AI',
      restrictTools: '仅对话回复（拒绝读写/命令等工具）',
      restrictHint: '关闭后 AI 拥有 dsh 完整工具权限，请自行评估风险。',
      loading: '正在读取配置…',
      unavailable: '当前 profile 没有暴露 noa-ark 的可编辑配置。',
      readonly: '当前配置为只读。',
      saveFailed: '保存失败，请重试。',
      saved: '已保存',
    };
    const en = {
      title: 'NOA Ark OneBot bridge',
      settingsLabel: 'NOA Ark',
      intro: 'Exposes the QQ official bot as OneBot v11 and isolates replies between OneBot clients and dsh.',
      onebot: 'OneBot service',
      enable: 'Enable the OneBot v11 service',
      mode: 'WS mode',
      modeForward: 'Forward server only',
      modeReverse: 'Reverse connections only',
      modeBoth: 'Forward + reverse',
      wsPort: 'Forward WS port',
      wsPath: 'Forward WS path',
      reverseUrls: 'Reverse WS URLs (one per line)',
      tokenHint: 'Set the access token in the profile config; the settings page never echoes secrets.',
      isolation: 'Reply isolation between dsh and OneBot',
      isolationAuto: 'Auto: pause dsh while an OneBot client is connected',
      isolationAlways: 'Always: dsh never replies to QQ messages',
      isolationOff: 'Off: both dsh and OneBot may reply',
      isolationHint: 'Auto needs at least one connected OneBot client; the first message while the bridge starts may still be handled by dsh. Always drops dsh replies, so make sure an OneBot client took over.',
      dshChat: 'dsh AI chat',
      dshChatEnable: 'Allow noa_dsh_chat to call the dsh AI',
      restrictTools: 'Chat only (reject read/write/command tools)',
      restrictHint: 'When off, the AI gets the full dsh tool set. Evaluate the risk yourself.',
      loading: 'Reading configuration…',
      unavailable: 'This profile does not expose editable noa-ark configuration.',
      readonly: 'Configuration is read-only.',
      saveFailed: 'Save failed. Try again.',
      saved: 'Saved',
    };

    function valueAt(root, path) {
      let current = root;
      for (const key of path) {
        if (current === undefined || current === null) return undefined;
        current = current[key];
      }
      return current;
    }

    function Row(props) {
      return React.createElement(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, marginBottom: 12 } },
        React.createElement('span', { style: { fontWeight: 600 } }, props.label),
        props.children,
        props.hint ? React.createElement('span', { style: { opacity: 0.68, fontSize: 12 } }, props.hint) : null,
      );
    }

    function Check(props) {
      return React.createElement(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12 } },
        React.createElement('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        React.createElement('span', null, props.label),
      );
    }

    const inputStyle = { padding: '6px 8px', fontSize: 13, borderRadius: 6, border: '1px solid rgba(128,128,128,.45)', background: 'transparent', color: 'inherit' };

    function Settings(props) {
      const scope = props.scope;
      const t = props.t;
      const subscribe = React.useMemo(() => scope.subscribe.bind(scope), [scope]);
      const getSnapshot = React.useMemo(() => scope.getSnapshot.bind(scope), [scope]);
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      const write = (path, value) => {
        setBusy(true);
        setNotice('');
        scope
          .mutate([{ op: 'set', path: path, value: value }])
          .then((accepted) => {
            setNotice(accepted ? t('saved') : t('saveFailed'));
          })
          .catch((error) => {
            setNotice(t('saveFailed') + ' ' + (error && error.message ? error.message : String(error)));
          })
          .finally(() => setBusy(false));
      };

      React.useEffect(() => {
        if (notice !== t('saved')) return undefined;
        const timer = setTimeout(() => setNotice(''), 1500);
        return () => clearTimeout(timer);
      }, [notice, t]);

      if (snapshot.status === 'loading') {
        return React.createElement('p', { style: { fontSize: 13, opacity: 0.7 } }, t('loading'));
      }
      if (snapshot.status === 'unavailable') {
        return React.createElement('p', { style: { fontSize: 13, opacity: 0.7 } }, t('unavailable'));
      }

      const config = snapshot.value || {};
      const onebot = config.onebot || {};
      const takeover = config.takeover || {};
      const dshChat = config.dshChat || {};
      const disabled = snapshot.writable !== true || busy;

      const textInput = (path, fallback) =>
        React.createElement('input', {
          type: 'text',
          style: inputStyle,
          defaultValue: valueAt(config, path) === undefined ? fallback : String(valueAt(config, path)),
          disabled: disabled,
          onBlur: (event) => {
            const next = event.target.value.trim();
            if (next !== String(valueAt(config, path) === undefined ? fallback : valueAt(config, path))) write(path, next);
          },
        });

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', fontSize: 13 } },
        React.createElement('p', { style: { marginTop: 0, opacity: 0.75 } }, t('intro')),
        !snapshot.writable
          ? React.createElement('p', { style: { opacity: 0.75 } }, t('readonly'))
          : null,
        React.createElement('h3', { style: { margin: '8px 0 10px' } }, t('onebot')),
        React.createElement(Check, {
          label: t('enable'),
          checked: onebot.enable === true,
          disabled: disabled,
          onChange: (value) => write(['onebot', 'enable'], value),
        }),
        React.createElement(
          Row,
          { label: t('mode') },
          React.createElement(
            'select',
            {
              style: inputStyle,
              value: onebot.mode || 'both',
              disabled: disabled,
              onChange: (event) => write(['onebot', 'mode'], event.target.value),
            },
            React.createElement('option', { value: 'forward' }, t('modeForward')),
            React.createElement('option', { value: 'reverse' }, t('modeReverse')),
            React.createElement('option', { value: 'both' }, t('modeBoth')),
          ),
        ),
        React.createElement(
          Row,
          { label: t('wsPort') },
          React.createElement('input', {
            type: 'number',
            min: 0,
            max: 65535,
            style: inputStyle,
            defaultValue: onebot.wsPort === undefined ? 7791 : onebot.wsPort,
            disabled: disabled,
            onBlur: (event) => {
              const port = Number(event.target.value);
              if (Number.isInteger(port) && port >= 0 && port <= 65535) write(['onebot', 'wsPort'], port);
            },
          }),
        ),
        React.createElement(
          Row,
          { label: t('wsPath') },
          textInput(['onebot', 'wsPath'], '/ws'),
        ),
        React.createElement(
          Row,
          { label: t('reverseUrls'), hint: t('tokenHint') },
          React.createElement('textarea', {
            rows: 3,
            style: { ...inputStyle, resize: 'vertical' },
            defaultValue: Array.isArray(onebot.reverseUrls) ? onebot.reverseUrls.join('\n') : '',
            disabled: disabled,
            onBlur: (event) => {
              const urls = event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
              write(['onebot', 'reverseUrls'], urls);
            },
          }),
        ),
        React.createElement('h3', { style: { margin: '8px 0 10px' } }, t('isolation')),
        React.createElement(
          Row,
          { label: t('isolation'), hint: t('isolationHint') },
          React.createElement(
            'select',
            {
              style: inputStyle,
              value: takeover.isolation || 'auto',
              disabled: disabled,
              onChange: (event) => write(['takeover', 'isolation'], event.target.value),
            },
            React.createElement('option', { value: 'auto' }, t('isolationAuto')),
            React.createElement('option', { value: 'always' }, t('isolationAlways')),
            React.createElement('option', { value: 'off' }, t('isolationOff')),
          ),
        ),
        React.createElement('h3', { style: { margin: '8px 0 10px' } }, t('dshChat')),
        React.createElement(Check, {
          label: t('dshChatEnable'),
          checked: dshChat.enable === true,
          disabled: disabled,
          onChange: (value) => write(['dshChat', 'enable'], value),
        }),
        React.createElement(Check, {
          label: t('restrictTools'),
          checked: dshChat.restrictTools !== false,
          disabled: disabled || dshChat.enable !== true,
          onChange: (value) => write(['dshChat', 'restrictTools'], value),
        }),
        React.createElement('p', { style: { opacity: 0.68, fontSize: 12, marginTop: 0 } }, t('restrictHint')),
        notice
          ? React.createElement('p', { role: 'status', style: { fontSize: 12, opacity: 0.8 } }, notice)
          : null,
      );
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      render() {
        if (this.state.error) {
          return React.createElement(
            'pre',
            { style: { whiteSpace: 'pre-wrap', fontSize: 12 } },
            'NOA 设置渲染失败：' + (this.state.error.message || String(this.state.error)),
          );
        }
        return this.props.children;
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'noa-ark: dictionaries');
      const t = ctx.locale.bind(NS);
      const scope = ctx.configForms.get('noa-ark');
      const ConfigView = (props) => React.createElement(Boundary, null, React.createElement(Settings, { ...props, scope: scope, t: t }));
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'noa-ark',
            order: 8,
            label: () => t('settingsLabel'),
          },
          ConfigView,
        ),
      );
      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.row.config',
            key: 'noa-ark#noa-ark',
            locale: NS,
            inject: () => ({ scope: scope, t: t }),
          },
          ConfigView,
        ),
      );
    }

    const module = { exports: {} };
    module.exports.apply = apply;
    module.exports.inject = inject;
    module.exports.name = 'noa-ark';
    return module.exports;
  },
});
