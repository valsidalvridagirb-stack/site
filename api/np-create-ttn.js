// Створює накладну (ТТН) Нової пошти для замовлення та зберігає номер у orders.ttn.
// Доступно лише адміну (перевірка через profiles.is_admin, як і в /api/catalog).
const { npCall, supaFetch, requireAdmin, getToken } = require('./_lib/np');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const token = getToken(req);
  try {
    await requireAdmin(token);

    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const { orderId, weight, cost, description } = body || {};
    if (!orderId) {
      res.status(400).json({ error: 'no_order_id' });
      return;
    }

    const orders = await supaFetch(`orders?id=eq.${encodeURIComponent(orderId)}&select=*`, token);
    if (!orders || !orders.length) {
      res.status(404).json({ error: 'order_not_found' });
      return;
    }
    const order = orders[0];
    if (order.ttn) {
      res.status(400).json({ error: 'already_has_ttn', ttn: order.ttn });
      return;
    }
    if (!order.city || !order.nova_poshta_dept || !order.customer_name || !order.customer_phone) {
      res.status(400).json({ error: 'incomplete_order', message: 'У замовленні не вистачає міста, відділення, імені або телефону' });
      return;
    }

    const items = await supaFetch(`order_items?order_id=eq.${encodeURIComponent(orderId)}&select=*`, token) || [];

    // --- відправник: власний рахунок Нової пошти (визначається за API-ключем) ---
    const senderList = await npCall('Counterparty', 'getCounterparties', { CounterpartyProperty: 'Sender', Page: '1' });
    if (!senderList || !senderList.length) throw new Error('Не знайдено відправника (Sender) — перевірте API-ключ Нової пошти');
    const senderRef = senderList[0].Ref;

    const senderAddresses = await npCall('Counterparty', 'getCounterpartyAddresses', { Ref: senderRef, CounterpartyProperty: 'Sender' });
    if (!senderAddresses || !senderAddresses.length) throw new Error('На акаунті Нової пошти не налаштовано адресу відправника (відділення, звідки відправляєте)');
    const senderAddress = senderAddresses[0];

    const senderContacts = await npCall('Counterparty', 'getCounterpartyContactPersons', { Ref: senderRef, Page: '1' });
    if (!senderContacts || !senderContacts.length) throw new Error('На акаунті Нової пошти не налаштовано контактну особу відправника');
    const senderContact = senderContacts[0];

    // --- отримувач: шукаємо відділення за містом і номером/текстом ---
    const deptMatch = String(order.nova_poshta_dept).match(/\d+/);
    const warehouses = await npCall('Address', 'getWarehouses', {
      CityName: order.city,
      FindByString: deptMatch ? deptMatch[0] : order.nova_poshta_dept,
      Page: '1',
      Limit: '5'
    });
    if (!warehouses || !warehouses.length) {
      throw new Error(`Не знайдено відділення "${order.nova_poshta_dept}" у місті "${order.city}". Перевірте написання міста й номер відділення в замовленні.`);
    }
    const warehouse = warehouses[0];

    // --- отримувач: приватна особа (створюється/повторно використовується на боці Нової пошти) ---
    const nameParts = String(order.customer_name).trim().split(/\s+/);
    const firstName = nameParts[0] || 'Клієнт';
    const lastName = nameParts.slice(1).join(' ') || 'Клієнт';

    const recipientSave = await npCall('Counterparty', 'save', {
      CounterpartyType: 'PrivatePerson',
      CounterpartyProperty: 'Recipient',
      FirstName: firstName,
      LastName: lastName,
      Phone: order.customer_phone
    });
    if (!recipientSave || !recipientSave.length) throw new Error('Не вдалось створити отримувача на боці Нової пошти');
    const recipientRef = recipientSave[0].Ref;
    let contactRecipientRef = null;
    if (recipientSave[0].ContactPerson && recipientSave[0].ContactPerson.data && recipientSave[0].ContactPerson.data.length) {
      contactRecipientRef = recipientSave[0].ContactPerson.data[0].Ref;
    } else {
      const recipContacts = await npCall('Counterparty', 'getCounterpartyContactPersons', { Ref: recipientRef, Page: '1' });
      if (recipContacts && recipContacts.length) contactRecipientRef = recipContacts[0].Ref;
    }
    if (!contactRecipientRef) throw new Error('Не вдалось визначити контактну особу отримувача на боці Нової пошти');

    const itemsDescription = description || (items.map(i => i.product_name).filter(Boolean).join(', ').slice(0, 100)) || 'Взуття/одяг';
    const finalWeight = Number(weight) > 0 ? Number(weight) : 1;
    const finalCost = Number(cost) > 0 ? Number(cost) : Number(order.total_price) || 0;

    const doc = await npCall('InternetDocument', 'save', {
      PayerType: 'Recipient',
      PaymentMethod: 'Cash',
      CargoType: 'Cargo',
      ServiceType: 'WarehouseWarehouse',
      SeatsAmount: '1',
      Weight: String(finalWeight),
      Description: itemsDescription,
      Cost: String(finalCost),
      CitySender: senderAddress.CityRef,
      Sender: senderRef,
      SenderAddress: senderAddress.Ref,
      ContactSender: senderContact.Ref,
      SendersPhone: senderContact.Phones || senderContact.Phone || '',
      CityRecipient: warehouse.CityRef,
      Recipient: recipientRef,
      RecipientAddress: warehouse.Ref,
      ContactRecipient: contactRecipientRef,
      RecipientsPhone: order.customer_phone
    });
    if (!doc || !doc.length || !doc[0].IntDocNumber) throw new Error('Нова пошта не повернула номер ТТН');
    const ttn = doc[0].IntDocNumber;

    try {
      await supaFetch(`orders?id=eq.${encodeURIComponent(orderId)}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ ttn, status: 'Відправлено', weight: finalWeight, declared_cost: finalCost })
      });
    } catch (saveErr) {
      // ТТН вже реально створено на боці Нової пошти — головне не загубити номер
      res.status(200).json({
        ttn,
        warning: 'ТТН створено, але не вдалось зберегти номер у замовленні автоматично. Запишіть номер і додайте вручну: ' + saveErr.message
      });
      return;
    }

    res.status(200).json({ ttn, warehouse: warehouse.Description, city: order.city });
  } catch (err) {
    const status = err && err.httpStatus ? err.httpStatus : 500;
    res.status(status).json({ error: 'server_error', message: String(err && err.message || err) });
  }
};
