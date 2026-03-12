// ========== PRICE ROUTES ==========

const router = require('express').Router();
const ctrl = require('../controllers/pricesController');

router.get('/:ticker', ctrl.getPrice);
router.post('/batch', ctrl.batchPrices);
router.post('/refresh', ctrl.refreshAll);

module.exports = router;
