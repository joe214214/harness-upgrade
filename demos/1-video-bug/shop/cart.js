// Cart model for Tiny Shop.
const cart = []

function addItem(name, price) {
  cart.push({ name, price })
}

function computeTotal(items) {
  let total = 0
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price
  }
  return total
}
