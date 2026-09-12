/* Food imagery is emoji: no network call, no CDN, works offline. That is a demo
 * requirement, not a shortcut - the dashboard must not be able to fail because an image
 * host is slow.
 *
 * Lookup order: exact name, then any word in the name, then the category fallback. */

const BY_NAME = {
  spinach: "🥬", "baby spinach": "🥬", lettuce: "🥬", kale: "🥬", cabbage: "🥬",
  "bell pepper": "🫑", pepper: "🫑", tomato: "🍅", cucumber: "🥒", zucchini: "🥒",
  carrot: "🥕", broccoli: "🥦", cauliflower: "🥦", mushroom: "🍄", corn: "🌽",
  onion: "🧅", "green onion": "🧅", garlic: "🧄", potato: "🥔", "sweet potato": "🍠",
  avocado: "🥑", eggplant: "🍆", lemon: "🍋", lime: "🍋", apple: "🍎", banana: "🍌",
  strawberry: "🍓", blueberry: "🫐", grape: "🍇", orange: "🍊", peach: "🍑",
  pear: "🍐", melon: "🍈", watermelon: "🍉", pineapple: "🍍", mango: "🥭",
  cherry: "🍒", coconut: "🥥", olive: "🫒", ginger: "🫚", chilli: "🌶️", chili: "🌶️",
  herbs: "🌿", cilantro: "🌿", parsley: "🌿", basil: "🌿", mint: "🌿",

  milk: "🥛", yogurt: "🥛", "greek yogurt": "🥛", cream: "🥛", "sour cream": "🥛",
  butter: "🧈", cheese: "🧀", "cheddar cheese": "🧀", "feta cheese": "🧀",
  mozzarella: "🧀", "cream cheese": "🧀", egg: "🥚",

  "chicken breast": "🍗", chicken: "🍗", turkey: "🍗", "ground beef": "🥩",
  beef: "🥩", steak: "🥩", pork: "🥩", lamb: "🥩", bacon: "🥓", sausage: "🌭",
  "deli meat": "🥓", ham: "🍖",

  salmon: "🐟", fish: "🐟", tuna: "🐟", shrimp: "🦐", prawn: "🦐", crab: "🦀",
  lobster: "🦞", scallop: "🦪", oyster: "🦪",

  bread: "🍞", tortilla: "🫓", bagel: "🥯", croissant: "🥐", baguette: "🥖",
  cake: "🍰", pastry: "🥐",

  tofu: "🧊", rice: "🍚", "cooked rice": "🍚", pasta: "🍝", noodle: "🍜",
  bean: "🫘", lentil: "🫘", nut: "🥜", flour: "🌾",

  leftovers: "🍲", soup: "🍲", stew: "🍲", curry: "🍛", pizza: "🍕", salad: "🥗",
  sandwich: "🥪",

  "orange juice": "🧃", juice: "🧃", water: "💧", beer: "🍺", wine: "🍷",
  soda: "🥤", coffee: "☕", tea: "🍵",

  ketchup: "🍅", mayonnaise: "🫙", mustard: "🫙", salsa: "🥫", hummus: "🫙",
  jam: "🍯", honey: "🍯", "soy sauce": "🫙", "hot sauce": "🌶️", pickle: "🥒",
};

const BY_CATEGORY = {
  produce: "🥗", dairy: "🥛", meat: "🍖", seafood: "🐟", bakery: "🍞",
  pantry: "🥫", leftovers: "🍲", beverage: "🧃", condiment: "🧂", other: "📦",
};

export function foodIcon(name = "", category = "other") {
  const key = String(name).toLowerCase().trim();
  if (BY_NAME[key]) return BY_NAME[key];

  // "red bell pepper" should still find the pepper.
  for (const word of key.split(/\s+/)) {
    if (BY_NAME[word]) return BY_NAME[word];
  }
  return BY_CATEGORY[category] || BY_CATEGORY.other;
}
