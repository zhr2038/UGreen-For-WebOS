import qrcode from 'qrcode-generator';
window.renderLoginQr = text => {
  const code = qrcode(0, 'M'); code.addData(text); code.make();
  return code.createSvgTag({ cellSize: 4, margin: 16, scalable: true, alt: '使用绿联云 App 扫码登录', title: '绿联云扫码登录' });
};
