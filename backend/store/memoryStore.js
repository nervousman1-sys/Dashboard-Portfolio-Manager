// ========== IN-MEMORY DATA STORE ==========

const store = {
    clients: [],
    priceCache: {},
    nextClientId: 1,
    users: [],
    nextUserId: 1
};

module.exports = store;
