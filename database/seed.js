const XLSX = require('xlsx');

// Sample customer data for testing
const customers = [
    { Name: 'أحمد محمد', Phone: '+966501234567' },
    { Name: 'فهد العتيبي', Phone: '+966551234568' },
    { Name: 'محمد الشمري', Phone: '+966531234569' },
    { Name: 'عبدالله القحطاني', Phone: '+966541234570' },
    { Name: 'خالد السبيعي', Phone: '+966561234571' },
    { Name: 'سلطان الدوسري', Phone: '+966571234572' },
    { Name: 'ناصر الحربي', Phone: '+966581234573' },
    { Name: 'عمر المطيري', Phone: '+966591234574' },
    { Name: 'يوسف الغامدي', Phone: '+966501234575' },
    { Name: 'تركي الزهراني', Phone: '+966511234576' }
];

// Create workbook
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(customers);

// Set column widths
ws['!cols'] = [
    { wch: 20 },  // Name
    { wch: 18 }   // Phone
];

XLSX.utils.book_append_sheet(wb, ws, 'Customers');

// Write file
XLSX.writeFile(wb, './sample-customers.xlsx');
console.log('✅ Created sample-customers.xlsx with 10 test customers');
