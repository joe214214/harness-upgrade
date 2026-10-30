// UI wiring for Tiny Shop.
window.onerror = (message, source, line) => {
  const box = document.getElementById('error')
  box.style.display = 'block'
  box.textContent = `${message}  (${source.split('/').pop()}:${line})`
}

function render() {
  document.getElementById('cart').textContent = cart.map(i => `${i.name} $${i.price}`).join(', ') || 'Cart is empty'
}

document.getElementById('add-coffee').onclick = () => { addItem('coffee', 4); render() }
document.getElementById('add-bagel').onclick = () => { addItem('bagel', 3); render() }
document.getElementById('checkout').onclick = () => {
  document.getElementById('total').textContent = `Total: $${computeTotal(cart)}`
}
render()
