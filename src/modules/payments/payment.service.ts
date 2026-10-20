
export type PaymentResult = {
  success: boolean;
  transactionId: string | null;
  message: string;
};

export const paymentService = {
  async processPayment(
    orderId: string,
    amount: number,
  ): Promise<PaymentResult> {
    if (!orderId || !Number.isFinite(amount) || amount <= 0) {
      return {
        success: false,
        transactionId: null,
        message: "Invalid payment details",
      };
    }

    // Simulated provider: deterministic and safe for local development.
    // No real money is charged.
    return {
      success: true,
      transactionId: `txn_${orderId}`,
      message: "Payment successful",
    };
  },
};
