export class DeliveryBlocked extends Error {
  constructor(state, message) {
    super(message);
    this.state = state;
  }
}

export class DeliveryWaiting extends DeliveryBlocked {}
