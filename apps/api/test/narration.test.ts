import { describe, expect, it } from 'vitest';
import { isVerificationCredit, parseNarration, sameName, tidyName } from '../src/services/books/narration';

const own = ['HRP AI LLP'];
const p = (d: string) => parseNarration(d, own);

describe('reading bank narrations (Yes Bank lines from a real statement)', () => {
  it('IMPS in and out: the name, masked account, bank and remark', () => {
    expect(p('IMPS/Shalini Pathak/XXX7885/RRN:603810452909/')).toMatchObject({ channel: 'imps', name: 'Shalini Pathak', masked: '7885' });
    expect(p('IMPS/NA/XXXX9042/RRN:532270204198/PC211125587441487/HDFC BANK/Harsha Rani/IFB')).toMatchObject({ name: 'Harsha Rani', masked: '9042', bank: 'HDFC BANK', remark: 'IFB' });
    expect(p('IMPS/NA/XXXX8730/RRN:604457001938/PC2802637134271896/HDFC BANK/Deepanshu Agarwal/GST Fees')).toMatchObject({ name: 'Deepanshu Agarwal', remark: 'GST Fees', masked: '8730' });
    expect(p('IMPS/NA/XXXX8730/RRN:631130680556/PC5439624122054007/HDFC BANK/Deepanshu Agarwal/Pentagon CA')).toMatchObject({ name: 'Deepanshu Agarwal', remark: 'Pentagon CA' });
  });
  it('NEFT: the payer, not the company itself', () => {
    expect(p('NEFT Cr-SBIN0004266-FOOD CORPORATION OF INDIA-HRP AI LLP-SBIN326314464479')).toMatchObject({ channel: 'neft', name: 'Food Corporation of India', ifsc: 'SBIN0004266' });
    expect(p('NEFT Cr-HDFC0000001-HARSHA RANI-HRP AI LLP-HDFCH01368824497')).toMatchObject({ name: 'Harsha Rani' });
    expect(p('NEFT Cr-UTIB0001506-RAZORPAY PAYMENTS PVT LTD-HRP AI LLP-AXISCN1297229649')).toMatchObject({ name: 'Razorpay Payments PVT LTD' });
  });
  it('UPI: the payer mobile digits in the UPI id', () => {
    expect(p('UPI/550012053407/From:XXXXXX7936-3@ybl/To:XXXXXX4463-7@ybl/Payment from PhonePe')).toMatchObject({ channel: 'upi', vpaDigits: '7936', name: null, remark: 'Payment from PhonePe' });
    expect(p('UPI/ramesh.kumar@okaxis/412345678901/Payment')).toMatchObject({ vpa: 'ramesh.kumar@okaxis', name: 'Ramesh Kumar' });
  });
  it('special lines: FD, UPI collection settlement, refund, card purchase', () => {
    expect(p('NET-New FD-HRP AI LLP-119840400013083 -1-SECTOR 78 NOIDA').special).toBe('fd');
    expect(p('115063600001082/763175492 UPI Collection Settlement/HRP AI LLP/CBS PAYABLE ACC').special).toBe('upi_settlement');
    expect(p('REFUND:250927:MICROSOFTBUS\\10TH FLOOR 10')).toMatchObject({ special: 'refund', merchant: 'Microsoft' });
    expect(p('PCA:2640:PERFPERFE108890:PERFECTION CONSULTING DELHI IND01-OCT-25 15:19:01')).toMatchObject({ special: 'card', merchant: 'Perfection Consulting' });
  });
  it('₹1 account checks', () => {
    const a = p('IMPS/API Banking EB/XXX6172/RRN:605199043331/');
    expect(isVerificationCredit(1, 'IMPS/API Banking EB/XXX6172/RRN:605199043331/', a)).toBe(true);
    expect(isVerificationCredit(0.98, 'NEFT Cr-UTIB0001506-RAZORPAY PAYMENTS PVT LTD-HRP AI LLP-AXISCN1297229649', p('NEFT Cr-UTIB0001506-RAZORPAY PAYMENTS PVT LTD-HRP AI LLP-AXISCN1297229649'))).toBe(true);
    expect(isVerificationCredit(3000, 'IMPS/Shalini Pathak/XXX7885/RRN:603810452909/', p('IMPS/Shalini Pathak/XXX7885/RRN:603810452909/'))).toBe(false);
  });
  it('names compare however they are spelt', () => {
    expect(sameName('HARSHA RANI', 'Harsha Rani')).toBe(true);
    expect(sameName('Mrs. Harsha Rani', 'HARSHA RANI')).toBe(true);
    expect(sameName('Food Corporation of India', 'FOOD CORPORATION OF INDIA')).toBe(true);
    expect(sameName('Harsha', 'Harsha Rani')).toBe(true);
    expect(sameName('Ram', 'Ram Kumar')).toBe(false);
    expect(tidyName('SHREE BALAJI TRADERS PVT LTD')).toBe('Shree Balaji Traders PVT LTD');
  });
});
