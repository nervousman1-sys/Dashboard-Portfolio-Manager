// ========== HOLDING ROUTES (nested under /api/clients) ==========

const router = require('express').Router();
const ctrl = require('../controllers/holdingsController');

router.post('/:id/holdings', ctrl.addHolding);
router.put('/:id/holdings/:holdingId', ctrl.editHolding);
router.delete('/:id/holdings/:holdingId', ctrl.removeHolding);

module.exports = router;
