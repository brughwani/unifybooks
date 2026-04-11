const Razorpay = require("razorpay");
const crypto = require("crypto");
const { db } = require("../admin");
const { track } = require("../mixpanel");

exports.createOrder = async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.status(204).send("");
    return;
  }

  try {
    const instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID || "dummy_key",
      key_secret: process.env.RAZORPAY_KEY_SECRET || "dummy_secret",
    });

    const { amount, sellerPan, receipt } = req.body;
    
    if (!amount || !sellerPan) {
      return res.status(400).json({ error: "amount and sellerPan are required" });
    }

    const sellerDoc = await db.collection("orgs").doc(sellerPan).get();
    
    if (!sellerDoc.exists) {
      return res.status(404).json({ error: "Seller organization not found" });
    }

    const orgData = sellerDoc.data();
    const bankDetails = orgData.bankDetails || {};

    // Validate that the seller at least provided bank details
    if (!bankDetails.accountNumber || !bankDetails.ifsc) {
        return res.status(400).json({ error: "Seller has not updated their bank details." });
    }

    let accountId = bankDetails.razorpayAccountId;

    // Auto-create Route Linked Account if it doesn't exist
    if (!accountId) {
        let cleanPhone = "9999999999";
        if (orgData.phone || orgData.phoneNumber) {
            cleanPhone = (orgData.phone || orgData.phoneNumber).replace(/\D/g, "").slice(-10);
            if (cleanPhone.length !== 10) cleanPhone = "9999999999";
        }
        
        const createOptions = {
          email: orgData.email || "seller@unifybooks.com",
          phone: cleanPhone,
          type: "route",
          reference_id: sellerPan,
          legal_business_name: orgData.shop_name || orgData.shopName || orgData.legal_name || orgData.ownerName || "Seller Business",
          business_type: "individual", // individual requires the least KYC friction at the start
          profile: {
              category: "ecommerce",
              subcategory: "other_ecommerce",
              addresses: {
                  registered: {
                      street1: "Unknown",
                      city: "Unknown", 
                      state: orgData.state || "Maharashtra",
                      postal_code: "400001",
                      country: "IN"
                  }
              }
          }
        };

        try {
            // Using older V1 accounts API which is standard in route creation
            const accRes = await instance.beta.accounts.create(createOptions);
            accountId = accRes.id;

            // Save to firestore so we don't recreate it next time
            await db.collection("orgs").doc(sellerPan).set({
                bankDetails: {
                    ...bankDetails,
                    razorpayAccountId: accountId
                }
            }, { merge: true });
        } catch (accErr) {
            console.error("Failed to dynamically create Route Account:", accErr);
            return res.status(500).json({ error: "Could not create routing profile for seller. Ensure app is registered for Route API." });
        }
    }

    // Now we have the linked account ID, we create the order routing to it
    const options = {
      amount: Math.round(amount * 100), // convert to paise
      currency: "INR",
      receipt: receipt || `rcpt_${Date.now()}`,
      transfers: [
        {
          account: accountId, // The generated or cached Linked Account ID
          amount: Math.round(amount * 100), // 100% of the funds
          currency: "INR",
          notes: {
            purpose: "UnifyBooks Invoice Payment"
          },
          linked_account_notes: ["purpose"],
          on_hold: 0
        }
      ]
    };

    const order = await instance.orders.create(options);
    
    track("payment_order_created", sellerPan, {
      amount: amount,
      receipt: receipt,
      razorpay_order_id: order.id,
      route_account_id: accountId
    });

    res.status(200).json(order);
  } catch (error) {
    console.error("Razorpay Order Error:", error);
    res.status(500).json({ error: error.message || "Failed to create order" });
  }
};

exports.verifyPayment = async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.status(204).send("");
    return;
  }

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const key_secret = process.env.RAZORPAY_KEY_SECRET || "dummy_secret";

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", key_secret)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      track("payment_verified", "system", {
        razorpay_order_id,
        razorpay_payment_id
      });
      res.status(200).json({ success: true, message: "Payment verified successfully" });
    } else {
      track("payment_verification_failed", "system", {
        razorpay_order_id,
        razorpay_payment_id
      });
      res.status(400).json({ success: false, message: "Invalid signature" });
    }
  } catch (error) {
    console.error("Verify Error:", error);
    res.status(500).json({ error: error.message || "Failed to verify" });
  }
};
